/**
 * DSH Local Browser Bridge — loopback server.
 *
 * Protocol
 * --------
 * - the Chrome/Edge extension long-polls GET /poll?token=..&client=<chrome|edge>&clientId=..
 * - the agent CLI enqueues a command through POST /enqueue and waits for the
 *   result on the same HTTP response
 * - the extension posts the result back through POST /result
 *
 * Routing guarantees (this is the part that used to be flaky):
 * - every client has its OWN FIFO of open /poll responses. A command for client
 *   X is delivered to X only, and only to a poll response that is still open.
 * - an enqueue wakes exactly one matching poll response atomically. A wake can
 *   never cancel a poll without answering it (the old single global `pollWaiter`
 *   did that, which made the extension wait for its 10s fetch abort => ~11s per
 *   command and cross-client delivery races).
 * - the long-poll is held for POLL_HOLD_MS (8s) and answered with 204, well
 *   inside the extension's 10s fetch timeout, so a healthy client re-polls
 *   immediately and a dead client cannot wedge the queue.
 *
 * Result contract
 * ---------------
 * The extension returns {id, ok:true, value} / {id, ok:false, error}. Older
 * extension builds forwarded the content-script envelope {ok,value} inside
 * `value`; `normalizeResult` unwraps that legacy shape and turns a nested
 * {ok:false,error} into a real bridge error. A success without a value is a
 * protocol violation and is reported loudly instead of silently returning
 * `undefined` to the CLI.
 *
 * Bound to 127.0.0.1 only, shared-token handshake, no files written.
 * Usage: node bridge/server.mjs [port]
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.DSH_BRIDGE_PORT ?? process.argv[2] ?? 18765);
const HOST = "127.0.0.1";
const TOKEN = process.env.DSH_BRIDGE_TOKEN || "dsh-bridge-local";
const BRIDGE_ID = "dsh-real-browser-bridge";
const OWNER_NONCE = process.env.DSH_BRIDGE_OWNER_NONCE || null;
const OWNER_LEASE_MS = Number(process.env.DSH_BRIDGE_OWNER_LEASE_MS || 5000);
const COMMAND_TIMEOUT_MS = Number(process.env.DSH_BRIDGE_COMMAND_TIMEOUT_MS || 90000);
const POLL_HOLD_MS = Number(process.env.DSH_BRIDGE_POLL_HOLD_MS || 8000);
const MAX_QUEUE = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CLIENT_STALE_MS = 120000;
const TRACE_POLLS = process.env.DSH_BRIDGE_TRACE_POLLS === "1";
const STARTED_AT = Date.now();
let lastOwnerHeartbeatAt = STARTED_AT;

/** id -> { command, resolve, timer, startedAt } */
const waiters = new Map();
/** pending commands (not yet handed to a client) */
const queue = [];
/** clientId -> array of open /poll responses (FIFO) */
const pollers = new Map();
/** clientId -> { browser, role, userAgent, lastSeen } */
const clients = new Map();
/** clientId -> poll statistics { count, lastAt, lastGapMs, maxGapMs, lastDeliverAt } */
const pollStats = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(new Error(`invalid json: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function auth(url) {
  return url.searchParams.get("token") === TOKEN;
}

/* ------------------------------------------------------------------ *
 * command queue + per-client poll delivery
 * ------------------------------------------------------------------ */

function takeCommandFor(clientId, browser) {
  const index = queue.findIndex((command) => {
    // A command pinned to a clientId must only reach that exact extension
    // instance; unpinned commands keep the legacy browser-name routing.
    if (command.clientId) return command.clientId === clientId;
    return !command.client || command.client === browser;
  });
  if (index < 0) return null;
  return queue.splice(index, 1)[0];
}

function closePoller(poller) {
  if (poller.closed) return;
  poller.closed = true;
  clearTimeout(poller.timer);
  const list = pollers.get(poller.clientId);
  if (!list) return;
  const index = list.indexOf(poller);
  if (index >= 0) list.splice(index, 1);
  if (list.length === 0) pollers.delete(poller.clientId);
}

function pollersFor(clientId) {
  let list = pollers.get(clientId);
  if (!list) {
    list = [];
    pollers.set(clientId, list);
  }
  return list;
}

/**
 * Hand the oldest deliverable command to the oldest open poll of `client`.
 * Returns true when a command was delivered.
 */
function pollStatsFor(clientId) {
  let stats = pollStats.get(clientId);
  if (!stats) {
    stats = { count: 0, lastAt: 0, lastGapMs: 0, maxGapMs: 0, lastDeliverAt: 0 };
    pollStats.set(clientId, stats);
  }
  return stats;
}

function notePoll(clientId) {
  const stats = pollStatsFor(clientId);
  const now = Date.now();
  const gap = stats.lastAt ? now - stats.lastAt : 0;
  stats.count += 1;
  stats.lastAt = now;
  stats.lastGapMs = gap;
  if (gap > stats.maxGapMs) stats.maxGapMs = gap;
  if (TRACE_POLLS) log(`poll-open clientId=${clientId} gapMs=${gap} count=${stats.count}`);
}

function announceDelivery(command, clientId) {
  command.deliveredAt = Date.now();
  command.deliveredTo = clientId;
  pollStatsFor(clientId).lastDeliverAt = command.deliveredAt;
  log(`deliver clientId=${clientId} cmd=${command.cmd} id=${command.id} waitedMs=${command.deliveredAt - command.queuedAt}`);
}

/**
 * Hand the oldest deliverable command to the oldest open poll of `client`.
 * Returns true when a command was delivered.
 */
function deliver(clientId) {
  for (;;) {
    const list = pollers.get(clientId);
    if (!list || list.length === 0) return false;
    const poller = list[0];
    if (poller.closed) {
      closePoller(poller);
      continue;
    }
    const command = takeCommandFor(clientId, clients.get(clientId)?.browser);
    if (!command) return false;
    closePoller(poller);
    announceDelivery(command, clientId);
    json(poller.res, 200, command);
    return true;
  }
}

function deliverAny() {
  for (const client of [...pollers.keys()]) {
    if (deliver(client)) return true;
  }
  return false;
}

function deliverBrowser(browser) {
  for (const [clientId, info] of clients) {
    if (info.browser === browser && deliver(clientId)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * result normalization
 * ------------------------------------------------------------------ */

/**
 * Detect the legacy content-script envelope: {ok:true, value} / {ok:false, error}
 * with no other keys. Returns null when `value` is a normal command payload.
 */
function contentEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  if (!keys.every((key) => key === "ok" || key === "value" || key === "error" || key === "code")) return null;
  if (typeof value.ok !== "boolean") return null;
  if (!("value" in value) && !("error" in value)) return null;
  return value;
}

function normalizeResult(message) {
  const base = { id: message.id };
  if (message.ok !== true) {
    return { ...base, ok: false, error: String(message.error || "bridge: extension reported failure without an error") };
  }
  if (!("value" in message)) {
    return { ...base, ok: false, error: "bridge-protocol: extension returned success without a value" };
  }
  const envelope = contentEnvelope(message.value);
  if (!envelope) return { ...base, ok: true, value: message.value };
  if (envelope.ok === true) {
    if (!("value" in envelope)) {
      return { ...base, ok: false, error: "bridge-protocol: content script returned success without a value" };
    }
    return { ...base, ok: true, value: envelope.value };
  }
  return { ...base, ok: false, error: String(envelope.error || "content-script error"), source: "content-script" };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();
  for (const [id, waiter] of waiters) {
    if (now - waiter.startedAt <= COMMAND_TIMEOUT_MS) continue;
    waiters.delete(id);
    clearTimeout(waiter.timer);
    const index = queue.indexOf(waiter.command);
    if (index >= 0) queue.splice(index, 1);
    const delivered = waiter.command.deliveredTo ? `delivered to ${waiter.command.deliveredTo}` : "never delivered (client not polling)";
    log(`timeout id=${id} cmd=${waiter.command.cmd} client=${waiter.command.client ?? "any"} ${delivered}`);
    waiter.resolve({
      id,
      ok: false,
      error: `bridge-timeout after ${COMMAND_TIMEOUT_MS}ms: ${waiter.command.cmd} (${delivered})`,
    });
  }
  for (const [clientId, info] of clients) {
    if (now - info.lastSeen > 10 * 60 * 1000) clients.delete(clientId);
  }
}, 5000).unref();

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return json(res, 400, { ok: false, error: "bad url" });
  }
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (!auth(url) && url.pathname !== "/test") return json(res, 403, { ok: false, error: "bad token" });

    /* ---------------------------- poll ---------------------------- */
    if (req.method === "GET" && url.pathname === "/poll") {
      const browser = String(url.searchParams.get("client") || "unknown");
      const clientId = String(url.searchParams.get("clientId") || `legacy:${browser}`);
      const role = url.searchParams.get("role") === "agent" ? "agent" : "real";
      const userAgent = String(url.searchParams.get("userAgent") || "");
      clients.set(clientId, { browser, role, userAgent, lastSeen: Date.now() });
      notePoll(clientId);
      // A fresh poll must itself take a queued command: commands can be enqueued
      // in the small window between one poll timing out and the next arriving,
      // and no pre-existing poller exists then (this was a "command sits queued
      // forever" bug; never rely on enqueue-time wake alone).
      const queuedForClient = takeCommandFor(clientId, browser);
      if (queuedForClient) {
        announceDelivery(queuedForClient, clientId);
        return json(res, 200, queuedForClient);
      }
      if (deliver(clientId)) return;
      if (res.writableEnded) return;

      const poller = { clientId, res, timer: null, closed: false };
      const list = pollersFor(clientId);
      list.push(poller);
      // Do not let a zombie tab accumulate open polls.
      while (list.length > 4) {
        const stale = list[0];
        closePoller(stale);
        if (!stale.res.writableEnded) {
          stale.res.writeHead(204, { "access-control-allow-origin": "*" });
          stale.res.end();
        }
        log(`poll-flood clientId=${clientId}: closed a stale poll`);
      }
      poller.timer = setTimeout(() => {
        if (poller.closed) return;
        closePoller(poller);
        if (TRACE_POLLS) log(`poll-timeout clientId=${clientId} hold=${POLL_HOLD_MS}ms`);
        if (!res.writableEnded) {
          res.writeHead(204, { "access-control-allow-origin": "*" });
          res.end();
        }
      }, POLL_HOLD_MS);
      res.on("close", () => closePoller(poller));
      return;
    }

    /* --------------------------- status --------------------------- */
    if (req.method === "GET" && url.pathname === "/status") {
      const now = Date.now();
      return json(res, 200, {
        ok: true,
        bridgeId: BRIDGE_ID,
        ownerNonce: OWNER_NONCE,
        ownerPid: OWNER_PID,
        ownerLeaseMs: OWNER_NONCE ? OWNER_LEASE_MS : null,
        ownerHeartbeatMsAgo: OWNER_NONCE ? now - lastOwnerHeartbeatAt : null,
        startedAt: STARTED_AT,
        uptimeMs: now - STARTED_AT,
        clients: Object.fromEntries(
          [...clients.entries()].map(([clientId, info]) => {
            const stats = pollStatsFor(clientId);
            return [
              clientId,
              {
                browser: info.browser,
                role: info.role,
                clientId,
                userAgent: info.userAgent,
                lastSeenMsAgo: now - info.lastSeen,
                stale: now - info.lastSeen > CLIENT_STALE_MS,
                polls: pollers.get(clientId)?.length ?? 0,
                pollCount: stats.count,
                lastPollMsAgo: stats.lastAt ? now - stats.lastAt : null,
                lastPollGapMs: stats.lastGapMs,
                maxPollGapMs: stats.maxGapMs,
                lastDeliverMsAgo: stats.lastDeliverAt ? now - stats.lastDeliverAt : null,
              },
            ];
          }),
        ),
        byBrowser: [...clients.entries()].reduce((groups, [clientId, info]) => {
          const group = groups[info.browser] || { total: 0, real: 0, agent: 0, clients: [] };
          group.total += 1;
          group[info.role === "agent" ? "agent" : "real"] += 1;
          group.clients.push(clientId);
          groups[info.browser] = group;
          return groups;
        }, {}),
        queued: queue.length,
        queue: queue.map((command) => ({
          id: command.id,
          cmd: command.cmd,
          client: command.client ?? "any",
          queuedMsAgo: now - command.queuedAt,
        })),
        pending: waiters.size,
        pendingCommands: [...waiters.values()].map((waiter) => ({
          id: waiter.command.id,
          cmd: waiter.command.cmd,
          client: waiter.command.client ?? "any",
          waitedMs: now - waiter.startedAt,
          deliveredTo: waiter.command.deliveredTo ?? null,
        })),
      });
    }

    /* ------------------------- owner heartbeat -------------------- */
    if (req.method === "POST" && url.pathname === "/heartbeat") {
      const body = await readBody(req);
      if (!OWNER_NONCE || body?.ownerNonce !== OWNER_NONCE) {
        return json(res, 409, { ok: false, error: "bridge-owner: nonce mismatch" });
      }
      lastOwnerHeartbeatAt = Date.now();
      return json(res, 200, { ok: true, bridgeId: BRIDGE_ID, ownerNonce: OWNER_NONCE });
    }

    /* --------------------------- enqueue -------------------------- */
    if (req.method === "POST" && url.pathname === "/enqueue") {
      const body = await readBody(req);
      const cmd = typeof body.cmd === "string" ? body.cmd.trim() : "";
      if (!cmd) return json(res, 400, { ok: false, error: "enqueue: cmd must be a non-empty string" });
      if (queue.length >= MAX_QUEUE) return json(res, 503, { ok: false, error: "bridge-busy: command queue is full" });
      const client = body.client ? String(body.client) : undefined;
      const clientId = body.clientId ? String(body.clientId) : undefined;
      const requestedTimeout = Number(body.timeoutMs);
      const timeoutMs =
        Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.min(requestedTimeout, COMMAND_TIMEOUT_MS)
          : COMMAND_TIMEOUT_MS;
      const command = {
        id: randomUUID(),
        cmd,
        client,
        clientId,
        args: body.args && typeof body.args === "object" ? body.args : {},
        queuedAt: Date.now(),
      };
      let settle = null;
      let finished = false;
      const resultPromise = new Promise((resolve) => {
        settle = resolve;
        const timer = setTimeout(() => {
          waiters.delete(command.id);
          const index = queue.indexOf(command);
          if (index >= 0) queue.splice(index, 1);
          const delivered = command.deliveredTo ? `delivered to ${command.deliveredTo}` : "never delivered (client not polling)";
          log(`timeout id=${command.id} cmd=${cmd} client=${client ?? "any"} ${delivered}`);
          resolve({ id: command.id, ok: false, error: `bridge-timeout after ${timeoutMs}ms: ${cmd} (${delivered})` });
        }, timeoutMs);
        waiters.set(command.id, {
          command,
          startedAt: Date.now(),
          timer,
          resolve: (value) => {
            clearTimeout(timer);
            waiters.delete(command.id);
            resolve(value);
          },
        });
      });
      // If the caller gives up (fetch abort), cancel the waiter and drop the
      // queued command instead of letting it execute later as a surprise.
      res.on("close", () => {
        if (finished) return;
        finished = true;
        const waiter = waiters.get(command.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiters.delete(command.id);
        const index = queue.indexOf(command);
        if (index >= 0) queue.splice(index, 1);
        const state = command.deliveredTo ? `delivered to ${command.deliveredTo}` : "still queued";
        log(`client-disconnect id=${command.id} cmd=${cmd} client=${client ?? "any"} ${state}`);
        settle({ id: command.id, ok: false, error: `client-disconnected: ${cmd} was cancelled by the caller` });
      });
      queue.push(command);
      log(`enqueue cmd=${cmd} client=${client ?? "any"} id=${command.id} queued=${queue.length} timeoutMs=${timeoutMs}`);
      if (client) deliverBrowser(client);
      else deliverAny();
      const result = await resultPromise;
      finished = true;
      return json(res, 200, result);
    }

    /* --------------------------- result -------------------------- */
    if (req.method === "POST" && url.pathname === "/result") {
      const body = await readBody(req);
      if (!body || typeof body.id !== "string" || body.id.length === 0) {
        return json(res, 400, { ok: false, error: "result: id is required" });
      }
      const waiter = waiters.get(body.id);
      if (!waiter) {
        log(`result-unknown id=${body.id}`);
        return json(res, 404, { ok: false, error: "unknown command id" });
      }
      if (body.client && waiter.command.client && body.client !== waiter.command.client) {
        log(`result-wrong-client id=${body.id} expected=${waiter.command.client} got=${body.client}`);
        return json(res, 409, { ok: false, error: `result: client mismatch for command ${body.id}` });
      }
      const normalized = normalizeResult(body);
      log(
        `result id=${body.id} cmd=${waiter.command.cmd} ok=${normalized.ok}` +
          (normalized.ok ? "" : ` error=${JSON.stringify(normalized.error).slice(0, 300)}`) +
          ` tookMs=${Date.now() - waiter.startedAt}`,
      );
      waiter.resolve(normalized);
      return json(res, 200, { ok: true });
    }

    /* --------------------------- test page ------------------------ */
    if (req.method === "GET" && url.pathname === "/test") {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bridge Test Page</title></head>
<body style="font:16px system-ui;padding:24px">
<h1 id="title">DSH bridge test</h1>
<p id="status">idle</p>
<input id="name" placeholder="type your name">
<button id="go" onclick="document.getElementById('status').textContent='clicked:'+(document.getElementById('name').value||'')">Go</button>
<a id="example" href="https://example.com/">example link</a>
</body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    return json(res, 404, { ok: false, error: "unknown route" });
  } catch (error) {
    log(`http-error ${req.method} ${req.url}: ${error?.message || error}`);
    return json(res, 500, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  log(`dsh-local-browser bridge listening on http://${HOST}:${PORT} (token required)`);
});
server.on("error", (error) => {
  log(`bridge-start-error ${error?.code || "unknown"}: ${error?.message || error}`);
  process.exitCode = 1;
  process.exit(1);
});

/* ------------------------- owner watchdog ------------------------- */
// The host plugin spawns this bridge detached (so the short-lived command that
// starts it can return), but the bridge must not outlive DSH itself: a leftover
// bridge keeps the DeepSeek Harness.exe image locked, so the NSIS updater/installer
// cannot replace the exe (silent install failure) and the process lingers hidden.
// Exit as soon as the process that spawned us is gone.
const OWNER_PID = process.ppid;
const OWNER_CHECK_MS = 750;
const OWNER_LOG_INTERVAL_MS = 60000;
let lastOwnerLogAt = 0;
function logOwnerCheck(message) {
  const now = Date.now();
  if (now - lastOwnerLogAt < OWNER_LOG_INTERVAL_MS) return;
  lastOwnerLogAt = now;
  log(message);
}
function ownerAlive() {
  if (!OWNER_PID || OWNER_PID <= 0) return true;
  try {
    process.kill(OWNER_PID, 0);
    return true;
  } catch (error) {
    // Only a definitive "no such process" means the owner is gone. EPERM (and
    // any unexpected error) must keep the bridge alive: a false positive here
    // would kill a healthy bridge in the middle of a real-browser session.
    // The check runs every 750 ms, so diagnostics are rate-limited.
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") {
      logOwnerCheck(`owner check EPERM for ${OWNER_PID}; keeping bridge alive`);
      return true;
    }
    logOwnerCheck(`owner check failed for ${OWNER_PID}: ${error?.message || error}`);
    return true;
  }
}
const ownerTimer = setInterval(() => {
  if (OWNER_NONCE && Date.now() - lastOwnerHeartbeatAt > OWNER_LEASE_MS) {
    clearInterval(ownerTimer);
    log(`owner heartbeat expired after ${OWNER_LEASE_MS}ms; bridge exiting`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
    return;
  }
  if (ownerAlive()) return;
  clearInterval(ownerTimer);
  log(`owner process ${OWNER_PID} is gone; bridge exiting`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}, OWNER_CHECK_MS);
ownerTimer.unref();
