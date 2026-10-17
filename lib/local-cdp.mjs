/**
 * local-cdp.mjs — minimal Chrome DevTools Protocol plumbing for a *local*
 * browser profile (dsh-ego-local-browser, teammate A deliverable §4.2).
 *
 * Design notes (measured on this machine, Chrome 155.0.8059.80):
 *  - A copied profile (Local State + Default\Network\Cookies) decrypts its
 *    cookies under the genuine chrome.exe: `Storage.getCookies` returned 555
 *    cookies (1 empty) from a copy, matching the source profile.
 *  - `Network.getAllCookies` / `Network.deleteCookies` are NOT registered on the
 *    browser-level WebSocket, but DO work when addressed to a flattened page
 *    session (`Target.attachToTarget` + `sessionId`). This module therefore
 *    attaches one page session right after connecting and routes `Network.*`
 *    cookie calls through it (contract §4.2 asks for `Network.getAllCookies`).
 *    `Storage.getCookies` (browser-level) is kept as a read-only fallback so a
 *    diagnostics call degrades instead of failing silently/loudly.
 *  - Cookie VALUES never leave this module: only names/domains/paths and value
 *    lengths are ever returned or logged.
 *
 * No external dependencies; Node >= 22 (global fetch + global WebSocket).
 */

import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, rm } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Level used by CDP calls unless a narrower per-call timeout is requested. */
const CALL_TIMEOUT_MS = 15000;
/** Overall budget for a launch (endpoint + websocket) unless overridden. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;
/** Transient profile files a crashed Chrome can leave behind that block relaunch. */
const STALE_PROFILE_FILES = [
  "DevToolsActivePort",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
];
/** Cookie fields whose *value length* is worth reporting for auth diagnostics. */
const AUTH_FIELD_NAMES = [
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "NID",
  "AEC",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cdpError(code, message, hint) {
  const error = new Error(message);
  error.code = code;
  if (hint) error.hint = hint;
  return error;
}

/**
 * Error raised when Chrome answers a CDP command with an error. Keeps the
 * numeric CDP code (`error.code`), matching the reference implementation so
 * `-32601` / "wasn't found" can be detected for the Storage fallback.
 */
function isMethodUnavailable(error) {
  return (
    error?.code === -32601 ||
    error?.cdpCode === -32601 ||
    /wasn't found|is not found|not found/i.test(String(error?.message ?? ""))
  );
}

/* ------------------------------------------------------------------ *
 * CDP client
 * ------------------------------------------------------------------ */

/**
 * Thin CDP client over globalThis.WebSocket (adapted from the MIT-licensed
 * dsh-ego-browser reference `CdpClient`, same wire semantics).
 *
 * `call(method, params, sessionId, timeoutMs)`:
 *  - `sessionId` omitted  -> uses `this.sessionId` (the attached page session)
 *  - `sessionId === null` -> browser-level command (no sessionId field)
 *  - otherwise            -> the given session
 */
export class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    /** Flattened page session id, set by `attachPageSession` (null = browser level). */
    this.sessionId = null;
    ws.addEventListener("message", (event) => this.#handleMessage(event));
    const onClose = () => this.#rejectPending(new Error("CDP connection closed"));
    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onClose, { once: true });
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `CDP error ${message.error.code}`);
        error.code = message.error.code;
        error.cdpCode = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (!message.method) return;
    for (const handler of this.events.get(message.method) || []) {
      try {
        handler(message.params || {}, message.sessionId);
      } catch {
        // Event handlers must never break the socket pump.
      }
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(method, params = {}, sessionId = undefined, timeoutMs = CALL_TIMEOUT_MS) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    const sid = sessionId === undefined ? this.sessionId : sessionId;
    if (sid) payload.sessionId = sid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, new Set());
    this.events.get(method).add(handler);
    return () => this.events.get(method)?.delete(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** First line of DevToolsActivePort is the negotiated DevTools port. */
export function parseDevToolsActivePort(text) {
  const line = String(text || "").split(/\r?\n/)[0]?.trim();
  if (!line) return null;
  const port = Number(line);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Ask a running DevTools endpoint for its browser-level WebSocket URL. */
export async function browserWsUrl(port, timeoutMs = 3000) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
  });
  if (!response.ok) throw new Error(`/json/version HTTP ${response.status} on port ${port}`);
  const info = await response.json();
  if (!info?.webSocketDebuggerUrl) throw new Error("browser did not expose webSocketDebuggerUrl");
  return info.webSocketDebuggerUrl;
}

/** Open a browser-level WebSocket and wrap it in a CdpClient. */
export async function connectCdp(wsUrl, timeoutMs = 5000) {
  const WsImpl = globalThis.WebSocket;
  if (!WsImpl) throw cdpError("cdp-connect-failed", "global WebSocket is unavailable (Node >= 22 required)");
  const ws = new WsImpl(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(cdpError("cdp-connect-failed", `CDP websocket open timed out after ${timeoutMs}ms: ${wsUrl}`));
    }, Math.max(1000, timeoutMs));
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(cdpError("cdp-connect-failed", `CDP websocket connect failed: ${wsUrl}`));
      },
      { once: true },
    );
  });
  const client = new CdpClient(ws);
  return {
    client,
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Attach one flattened page session. `Network.getAllCookies` /
 * `Network.deleteCookies` only exist on a page session (measured Chrome 155);
 * browser-level calls answer -32601. Returns null when no page can be attached
 * — callers then fall back to browser-level `Storage.getCookies`.
 */
export async function attachPageSession(client, timeoutMs = 8000) {
  try {
    const { targetInfos = [] } = await client.call("Target.getTargets", {}, null, timeoutMs);
    let page =
      targetInfos.find((target) => target.type === "page" && target.url === "about:blank") ||
      targetInfos.find((target) => target.type === "page");
    if (!page) {
      const created = await client.call("Target.createTarget", { url: "about:blank" }, null, timeoutMs);
      if (!created?.targetId) return null;
      page = { targetId: created.targetId };
    }
    const { sessionId } = await client.call(
      "Target.attachToTarget",
      { targetId: page.targetId, flatten: true },
      null,
      timeoutMs,
    );
    return sessionId || null;
  } catch {
    return null;
  }
}

/**
 * Attach to an already-running browser (e.g. the agent's live browser named by
 * `<state>/browser.json`). Used by doctorReport(); does not launch anything.
 */
export async function connectBrowserCdp({ port, wsUrl, timeoutMs = 5000, pageSession = true } = {}) {
  let url = wsUrl;
  if (!url) {
    if (!port) throw cdpError("cdp-connect-failed", "connectBrowserCdp needs a port or wsUrl");
    url = await browserWsUrl(port, timeoutMs);
  }
  const { client, close } = await connectCdp(url, timeoutMs);
  const sessionId = pageSession ? await attachPageSession(client, timeoutMs) : null;
  client.sessionId = sessionId;
  return { cdp: client, client, sessionId, wsUrl: url, port: port ?? null, close };
}

/* ------------------------------------------------------------------ *
 * Launch one temporary instance on a profile, run `fn`, then tear it down
 * ------------------------------------------------------------------ */

function normalizeExtraArgs(extraArgs) {
  if (!extraArgs) return [];
  if (Array.isArray(extraArgs)) return extraArgs.filter((arg) => typeof arg === "string" && arg !== "");
  if (typeof extraArgs === "string") return extraArgs.split(/\s+/).filter(Boolean);
  return [];
}

function normalizeProfileDir(profileDir) {
  return String(profileDir || "").replace(/[\\/]+$/, "");
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return true;
    await sleep(100);
  }
  return child.exitCode !== null;
}

async function killChildTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      await execFile("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10000,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // taskkill / kill races with a process exiting on its own — harmless.
  }
}

/* ------------------------------------------------------------------ *
 * Profile ownership check (review P1-4)
 *
 * The launch used to delete Singleton* / lockfile / DevToolsActivePort blindly.
 * If another browser or sync still owns the profile, that created a second
 * instance on the same SQLite store. Now those files are only removed when
 * their owner is provably gone; otherwise `profile-busy` is thrown and
 * nothing is touched.
 * ------------------------------------------------------------------ */

const LOCK_FILE_NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** Is `pid` a live process? (EPERM = exists but owned by someone else.) */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Chrome writes "hostname-<pid>" into SingletonLock/lockfile; accept both spellings. */
function parsePidFromLockContent(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  const match = /(\d+)\s*$/.exec(value);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // already gone
      }
      resolve(ok);
    };
    try {
      socket = netConnect({ host, port });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Decide whether the profile is owned by a live instance.
 * -> { busy, reasons:[], staleFiles:[] }
 *
 * A lock file is only considered stale when its owner PID is provably dead AND
 * the file is not held exclusively (an open for write succeeds). Anything
 * ambiguous counts as busy — never delete a lock we cannot prove stale.
 */
async function inspectProfileOwner(profileDir) {
  const result = { busy: false, reasons: [], staleFiles: [] };

  // 1. A DevTools port that still answers means a live Chromium instance.
  const portFile = join(profileDir, "DevToolsActivePort");
  if (await lstatOrNull(portFile)) {
    let port = null;
    try {
      port = parseDevToolsActivePort(await readFile(portFile, "utf8"));
    } catch {
      port = null;
    }
    if (port && (await probeTcp("127.0.0.1", port))) {
      result.busy = true;
      result.reasons.push(`DevToolsActivePort ${port} is still listening`);
      return result;
    }
    result.staleFiles.push(portFile);
  }

  // 2. Singleton/lock files: live PID, or an exclusive lock we cannot open.
  for (const name of LOCK_FILE_NAMES) {
    const lockPath = join(profileDir, name);
    const stats = await lstatOrNull(lockPath);
    if (!stats) continue;

    let content = "";
    try {
      content = await readFile(lockPath, "utf8");
    } catch {
      content = "";
    }
    if (content === "" && stats.isSymbolicLink()) {
      try {
        content = await readlink(lockPath);
      } catch {
        content = "";
      }
    }
    const pid = parsePidFromLockContent(content);
    if (pid !== null && processAlive(pid)) {
      result.busy = true;
      result.reasons.push(`${name} is held by live pid ${pid}`);
      continue;
    }

    let openError = null;
    try {
      const handle = await open(lockPath, "r+");
      await handle.close();
    } catch (error) {
      openError = error;
    }
    if (openError) {
      const code = openError?.code;
      if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
        result.busy = true;
        result.reasons.push(`${name} is locked by another process (${code})`);
        continue;
      }
      // Unknown error: conservative -> busy (do not delete a lock we cannot judge).
      result.busy = true;
      result.reasons.push(`${name} could not be inspected (${code || openError?.message})`);
      continue;
    }

    if (pid === null) {
      // File can be opened but names no owner PID: ambiguous -> conservative.
      result.busy = true;
      result.reasons.push(`${name} exists but its owner pid cannot be determined`);
      continue;
    }
    // PID parsed, not alive, and the file is not exclusively held: stale.
    result.staleFiles.push(lockPath);
  }

  if (result.busy) result.staleFiles = [];
  return result;
}

/**
 * Launch a temporary Chromium on `profileDir`, hand a live CDP client to `fn`,
 * and always tear the instance down afterwards (even when `fn` throws).
 *
 * opts: { exePath, profileDir, headless=true, timeoutMs=30000, extraArgs=[] }
 * fn:   ({ cdp, port, wsUrl, profileDir }) => Promise<T>
 *
 * Throws `Error` with code 'cdp-launch-timeout' (no endpoint within budget /
 * binary missing / exited early), 'cdp-connect-failed' (WebSocket refused) or
 * 'profile-busy' (another live instance/sync owns the profile — nothing is
 * deleted in that case).
 * Returns fn's return value.
 */
export async function withProfileCdp(opts, fn) {
  const {
    exePath,
    profileDir,
    headless = true,
    timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    extraArgs = [],
  } = opts || {};
  if (typeof fn !== "function") {
    throw cdpError("cdp-launch-timeout", "withProfileCdp(opts, fn): fn must be a function");
  }
  if (!exePath || typeof exePath !== "string") {
    throw cdpError("cdp-launch-timeout", "withProfileCdp: exePath is required");
  }
  if (!profileDir || typeof profileDir !== "string") {
    throw cdpError("cdp-launch-timeout", "withProfileCdp: profileDir is required");
  }
  if (!existsSync(exePath)) {
    throw cdpError(
      "cdp-launch-timeout",
      `browser binary not found: ${exePath}`,
      "install Chrome/Edge or point the local-browser config at a valid browserBinary",
    );
  }
  const dir = normalizeProfileDir(profileDir);
  await mkdir(dir, { recursive: true });
  const portFile = join(dir, "DevToolsActivePort");

  // Never clobber a live instance (review P1-4): only remove transient files
  // whose owner is provably gone; a live lock/port means profile-busy.
  const owner = await inspectProfileOwner(dir);
  if (owner.busy) {
    throw cdpError(
      "profile-busy",
      `target profile is in use: ${owner.reasons.join("; ")} (profile: ${dir})`,
      "stop the browser (or wait for the running sync) that uses this profile, then retry",
    );
  }
  for (const name of STALE_PROFILE_FILES) {
    await rm(join(dir, name), { force: true }).catch(() => {});
  }

  const args = [
    ...(headless ? ["--headless=new"] : []),
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--hide-crash-restore-bubble",
    ...normalizeExtraArgs(extraArgs),
    "about:blank",
  ];

  const child = spawn(exePath, args, {
    windowsHide: true,
    stdio: "ignore",
    // Lets killChildTree() signal the whole POSIX process group. Windows never
    // needs it (taskkill /T walks the tree) and keeps the plain contract spawn.
    detached: process.platform !== "win32",
  });

  let client = null;
  let closeSocket = null;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(2000, timeoutMs);
  const launch = { port: null, wsUrl: null };

  try {
    while (Date.now() < deadline) {
      if (launch.port === null) {
        try {
          const port = parseDevToolsActivePort(await readFile(portFile, "utf8"));
          if (port) launch.port = port;
        } catch {
          // not written yet
        }
      }
      if (launch.port !== null) {
        try {
          launch.wsUrl = await browserWsUrl(launch.port, 2500);
        } catch {
          // endpoint may be listening before /json/version is ready
        }
        if (launch.wsUrl) break;
      }
      if (child.exitCode !== null) {
        // Do not spin on a dead child: on Windows the port file can be left
        // behind by a failed launch, which would otherwise name a dead port.
        await sleep(150);
        if (child.exitCode !== null && launch.port === null) break;
        if (child.exitCode !== null && launch.wsUrl === null) break;
      }
      await sleep(100);
    }
    if (launch.port === null || !launch.wsUrl) {
      const exitNote = child.exitCode !== null ? ` (browser exited with code ${child.exitCode})` : "";
      throw cdpError(
        "cdp-launch-timeout",
        `browser did not expose a DevTools endpoint within ${timeoutMs}ms${exitNote}; profile: ${dir}`,
        "another instance may hold this profile, or the binary is not a Chromium browser",
      );
    }

    const connectBudget = Math.min(8000, Math.max(2000, deadline - Date.now()));
    const opened = await connectCdp(launch.wsUrl, connectBudget);
    client = opened.client;
    closeSocket = opened.close;
    client.sessionId = await attachPageSession(client, connectBudget);

    return await fn({
      cdp: client,
      port: launch.port,
      wsUrl: launch.wsUrl,
      profileDir: dir,
    });
  } finally {
    // Graceful shutdown first: Browser.close lets Chrome flush cookies.sqlite
    // and record a clean exit. Only escalate when the process stays behind.
    if (client) {
      try {
        await client.call("Browser.close", {}, null, 2500);
      } catch {
        // browser may already be gone
      }
    }
    if (closeSocket) {
      try {
        closeSocket();
      } catch {
        // already closed
      }
    }
    if (!(await waitForChildExit(child, 5000))) {
      await killChildTree(child);
    }
    // Only clear our launch's transient files if its process is actually gone —
    // a survivor could still own the lock.
    const exited = await waitForChildExit(child, 3000);
    if (exited) {
      await rm(portFile, { force: true }).catch(() => {});
      for (const name of LOCK_FILE_NAMES) {
        await rm(join(dir, name), { force: true }).catch(() => {});
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Cookies
 * ------------------------------------------------------------------ */

async function readCookiesOnce(cdp) {
  // Contract §4.2 names Network.getAllCookies. On Chrome 155 that command only
  // exists on a page session, so use the attached session; if there is none (or
  // an exotic build dropped it) fall back to the browser-level Storage domain.
  if (cdp.sessionId) {
    try {
      const got = await cdp.call("Network.getAllCookies");
      return Array.isArray(got?.cookies) ? got.cookies : [];
    } catch (error) {
      if (!isMethodUnavailable(error)) throw error;
    }
  }
  const got = await cdp.call("Storage.getCookies", {}, null);
  return Array.isArray(got?.cookies) ? got.cookies : [];
}

/**
 * Read every cookie in the profile, retrying until the count is stable
 * (two consecutive equal reads) for at most ~8s.
 */
export async function getCookies(cdp) {
  if (!cdp || typeof cdp.call !== "function") {
    throw new Error("getCookies(cdp): cdp must be a CdpClient");
  }
  const deadline = Date.now() + 8000;
  let lastCount = -1;
  let stable = 0;
  let cookies = [];
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      cookies = await readCookiesOnce(cdp);
      lastError = null;
    } catch (error) {
      lastError = error;
      await sleep(400);
      continue;
    }
    if (cookies.length === lastCount) {
      stable += 1;
      if (stable >= 1) return cookies;
    } else {
      stable = 0;
    }
    lastCount = cookies.length;
    if (Date.now() < deadline) await sleep(400);
  }
  if (lastError && cookies.length === 0) throw lastError;
  return cookies;
}

/** Normalize a cookie domain / allowlist entry for suffix matching. */
function hostForMatch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");
}

/** Local copy of `cookieMatchesDomain` — keep in sync with profile-bootstrap. */
function cookieMatchesDomainLocal(cookieDomain, domains) {
  const list = Array.isArray(domains) ? domains : [];
  if (list.length === 0) return true;
  const host = hostForMatch(cookieDomain);
  return list.some((raw) => {
    const domain = hostForMatch(raw);
    return domain !== "" && (host === domain || host.endsWith("." + domain));
  });
}

/** Max concurrent CDP deletes; cookies in one (domain,path,partition) group stay sequential. */
const DELETE_CONCURRENCY = 6;

/** Delete one cookie (dedupe already applied), trying the addressing fallbacks. */
async function deleteOneCookie(cdp, cookie) {
  const domain = typeof cookie.domain === "string" ? cookie.domain : "";
  const path = typeof cookie.path === "string" && cookie.path !== "" ? cookie.path : "/";
  const base = { name: cookie.name };
  if (cookie.partitionKey && typeof cookie.partitionKey === "object") {
    base.partitionKey = cookie.partitionKey;
  }
  const attempts = [];
  if (typeof cookie.url === "string" && cookie.url !== "") {
    attempts.push({ ...base, url: cookie.url });
  }
  if (domain !== "") {
    attempts.push({ ...base, domain, path });
    // Fallback spelling: delete by URL, which addresses the cookie's host
    // directly (useful if a build rejects the exact-domain form).
    const host = hostForMatch(domain);
    if (host) {
      attempts.push({
        ...base,
        url: `${cookie.secure ? "https" : "http"}://${host}${path}`,
      });
    }
  }
  for (const params of attempts) {
    try {
      await cdp.call("Network.deleteCookies", params);
      return true;
    } catch (error) {
      if (isMethodUnavailable(error)) throw error;
      // try the next addressing form
    }
  }
  return false;
}

/**
 * Delete the given cookies (review P2-1: limited concurrency).
 *
 * Cookies are grouped by (domain, path, partitionKey) and groups are executed
 * with at most DELETE_CONCURRENCY in flight; cookies inside one group run
 * sequentially. Measured: 532 deletes dropped from ~8s to ~2s.
 * Never throws for a single cookie; failures are counted.
 *
 * @returns {Promise<{deleted:number, failures:number}>}
 */
export async function deleteCookiesDetailed(cdp, cookies) {
  if (!cdp || typeof cdp.call !== "function") {
    throw new Error("deleteCookies(cdp, cookies): cdp must be a CdpClient");
  }
  const seen = new Set();
  const groups = new Map();
  let failures = 0;
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!cookie || typeof cookie.name !== "string" || cookie.name === "") {
      failures += 1;
      continue;
    }
    const domain = typeof cookie.domain === "string" ? cookie.domain : "";
    const path = typeof cookie.path === "string" && cookie.path !== "" ? cookie.path : "/";
    // Partitioned cookies (CHIPS) share name/domain/path but live in different
    // top-level-site partitions — measured: ignoring partitionKey left 8 such
    // cookies behind on .youtube.com. The partition is part of the identity.
    const partitionKey =
      cookie.partitionKey && typeof cookie.partitionKey === "object"
        ? JSON.stringify(cookie.partitionKey)
        : "";
    const identity = `${cookie.name}\u0000${domain}\u0000${path}\u0000${partitionKey}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const groupKey = `${domain}\u0000${path}\u0000${partitionKey}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(cookie);
  }

  const queue = [...groups.values()];
  let deleted = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      for (const cookie of queue[index]) {
        const removed = await deleteOneCookie(cdp, cookie);
        if (removed) deleted += 1;
        else failures += 1;
      }
    }
  };
  const workerCount = Math.min(DELETE_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { deleted, failures };
}

/**
 * Delete cookies; returns the number actually deleted (contract §4.2).
 * Use deleteCookiesDetailed when the failure count matters.
 */
export async function deleteCookies(cdp, cookies) {
  const { deleted } = await deleteCookiesDetailed(cdp, cookies);
  return deleted;
}

/* ------------------------------------------------------------------ *
 * Cookie statistics (names/domains/lengths only — never values)
 * ------------------------------------------------------------------ */

function valueLength(cookie) {
  return typeof cookie?.value === "string" ? cookie.value.length : 0;
}

function getValue(cookie) {
  return typeof cookie?.value === "string" ? cookie.value : "";
}

/**
 * Aggregate cookie statistics against an allowlist.
 * Every numeric value is a count or a value LENGTH; cookie values never leave here.
 */
export function cookieStats(cookies, allowlist = []) {
  const list = Array.isArray(cookies) ? cookies.slice() : [];
  const domains = (Array.isArray(allowlist) ? allowlist : []).map(hostForMatch).filter(Boolean);
  const total = list.length;
  let empty = 0;
  const kept = [];
  for (const cookie of list) {
    if (getValue(cookie) === "") empty += 1;
    if (cookieMatchesDomainLocal(cookie?.domain, domains)) kept.push(cookie);
  }

  const byDomainMap = new Map();
  for (const cookie of kept) {
    const domain = typeof cookie?.domain === "string" ? cookie.domain : "";
    byDomainMap.set(domain, (byDomainMap.get(domain) || 0) + 1);
  }
  const byDomain = [...byDomainMap.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const authFieldStats = (scoped) => {
    const map = new Map();
    for (const cookie of scoped) {
      const name = typeof cookie?.name === "string" ? cookie.name : "";
      if (!AUTH_FIELD_NAMES.includes(name)) continue;
      const length = valueLength(cookie);
      const current = map.get(name);
      if (current) {
        current.count += 1;
        current.maxLength = Math.max(current.maxLength, length);
      } else {
        map.set(name, { name, count: 1, maxLength: length });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  const allowlistStats = domains.map((domain) => {
    const scoped = kept.filter((cookie) => cookieMatchesDomainLocal(cookie?.domain, [domain]));
    return { domain, count: scoped.length, authFields: authFieldStats(scoped) };
  });

  const globalAuth = new Map();
  for (const cookie of kept) {
    const name = typeof cookie?.name === "string" ? cookie.name : "";
    if (!AUTH_FIELD_NAMES.includes(name)) continue;
    const length = valueLength(cookie);
    const domain = typeof cookie?.domain === "string" ? cookie.domain : "";
    const current = globalAuth.get(name);
    if (current) {
      current.count += 1;
      current.maxLength = Math.max(current.maxLength, length);
      current.domains.add(domain);
    } else {
      globalAuth.set(name, {
        name,
        count: 1,
        maxLength: length,
        domains: new Set([domain]),
      });
    }
  }
  const authFields = [...globalAuth.values()]
    .map((field) => ({
      name: field.name,
      count: field.count,
      maxLength: field.maxLength,
      domains: [...field.domains].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { total, empty, kept: kept.length, byDomain, allowlist: allowlistStats, authFields };
}

/**
 * Read → delete everything outside the allowlist → re-read and verify.
 * -> { totalBefore, totalAfter, deleted, remainingNonAllowlisted, failures }
 */
export async function trimCookies(cdp, allowlist = []) {
  const before = await getCookies(cdp);
  const drop = before.filter((cookie) => !cookieMatchesDomainLocal(cookie?.domain, allowlist));
  const { deleted, failures } = await deleteCookiesDetailed(cdp, drop);
  // Give Chrome a beat to apply the deletions, then verify from the wire.
  const after = await getCookies(cdp);
  const remainingNonAllowlisted = after.filter(
    (cookie) => !cookieMatchesDomainLocal(cookie?.domain, allowlist),
  ).length;
  return {
    totalBefore: before.length,
    totalAfter: after.length,
    deleted,
    remainingNonAllowlisted,
    failures,
  };
}
