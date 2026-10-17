/**
 * Bridge verification matrix, runs against a real browser client via the loopback bridge.
 * Prints PASS/FAIL per capability, saves evidence screenshots and a full log.
 *
 * Determinism rules:
 * - every command is scoped to the test tab (`tabId`), including `js` and
 *   `screenshot`; the matrix never depends on which tab happens to be active;
 * - after navigation it activates the test tab and waits for a rendered viewport
 *   plus a content-script readiness handshake (`ping`, with a legacy snapshot
 *   probe for extension builds that predate `ping`);
 * - content commands assert their response shape, and a failed command records
 *   the real error message instead of an "undefined" value;
 * - bounded retries only; a genuinely broken capability fails loudly.
 *
 * Usage: node bridge/verify.mjs <chrome|edge>
 * Log:   E:\AI\DeepSeek\workspace\local-browser\evidence\verify-<client>.log
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "dsh-bridge-local";
const client = process.argv[2] || "chrome";
const EVIDENCE = "E:\\AI\\DeepSeek\\workspace\\local-browser\\evidence";
const VISION = "E:\\AI\\DeepSeek\\workspace\\local-browser\\bridge\\vision.js";
const LOG_PATH = join(EVIDENCE, `verify-${client}.log`);
const TEST_URL = `http://127.0.0.1:${PORT}/test`;
const TEST_TITLE = "Bridge Test Page";
/** Per-command bridge timeout: long enough for real work, short enough that a
 *  wedged content script or suspended client fails loudly instead of hanging 90s. */
const COMMAND_TIMEOUT_MS = 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const logLines = [];
let currentTabId = null;
let closed = false;

function out(line) {
  console.log(line);
  logLines.push(line);
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  out(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  \u2014 " + detail : ""}`);
}

function brief(value, max = 220) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return "undefined";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function cmd(command, args = {}) {
  const response = await fetch(`${BASE}/enqueue?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: command, args, client, timeoutMs: COMMAND_TIMEOUT_MS }),
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS + 10000),
  });
  const json = await response.json();
  if (!json || json.ok !== true) {
    throw new Error(`${command}: ${json?.error || "no response"}`);
  }
  return json.value;
}

async function js(expression, tabId = currentTabId) {
  if (!tabId) throw new Error("js: no tabId");
  return cmd("js", { tabId, expression });
}

async function screenshot(path) {
  const value = await cmd("screenshot", { tabId: currentTabId });
  if (!value?.dataUrl) throw new Error(`screenshot returned no dataUrl: ${brief(value)}`);
  const data = Buffer.from(String(value.dataUrl).replace(/^data:image\/png;base64,/, ""), "base64");
  if (data.length < 500) throw new Error(`screenshot too small: ${data.length} bytes`);
  await writeFile(path, data);
  return `${path} (${data.length} bytes)`;
}

async function status() {
  const response = await fetch(`${BASE}/status?token=${TOKEN}`, { signal: AbortSignal.timeout(5000) });
  return response.json();
}

async function retry(label, fn, attempts = 4, delayMs = 350) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`);
}

/**
 * Wait until the requested client has polled recently.
 * A suspended MV3 service worker only re-polls when its 30s alarm fires (or a
 * content-script keepalive wakes it), so allow a generous window before the run
 * starts; once commands flow, each command's API calls keep the worker awake.
 */
async function waitForClient(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no status";
  while (Date.now() < deadline) {
    try {
      const state = await status();
      const entry = state.clients?.[client];
      last = `clients=${Object.keys(state.clients ?? {}).join(",") || "none"}`;
      if (entry && entry.lastSeenMsAgo < 12000) return { ...entry, last };
    } catch (error) {
      last = error?.message || String(error);
    }
    await sleep(400);
  }
  throw new Error(`client ${client} not connected/healthy: ${last}`);
}

/** Wait for the bridge to have no in-flight commands (other agents may be using it). */
async function waitForBridgeIdle(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await status();
    if (state.pending === 0 && state.queued === 0) return true;
    await sleep(250);
  }
  return false;
}

async function waitForPage(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let info = null;
  while (Date.now() < deadline) {
    info = await cmd("page_info", { tabId });
    if (info?.title === TEST_TITLE) return info;
    await sleep(200);
  }
  throw new Error(`page did not reach "${TEST_TITLE}": title=${brief(info?.title)}`);
}

/** Make the test tab the active, focused, rendered tab (visibility checks need layout). */
async function ensureRendered(tabId, attempts = 4) {
  let info = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cmd("activate", { tabId });
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    await sleep(300);
    info = await cmd("page_info", { tabId });
    if ((info?.viewport?.w ?? 0) > 0 && (info?.viewport?.h ?? 0) > 0) return info;
  }
  return info;
}

/**
 * Bounded content-script readiness gate.
 * New extension: background `ping` returns {protocol}; legacy extension: background
 * has no ping command, so probe with `snapshot` instead.
 */
async function waitContentReady(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const pong = await retry("ping", () => cmd("ping", { tabId }), 2, 200);
      if (pong && (pong.protocol || pong.legacy)) {
        return { mode: "ping", protocol: pong.protocol ?? 0, legacy: !!pong.legacy };
      }
      if (pong && pong.ready === true) return { mode: "ping", protocol: pong.protocol ?? 0 };
      last = `unexpected ping value: ${brief(pong)}`;
    } catch (error) {
      last = error?.message || String(error);
      if (/unknown bridge command: ping/i.test(last)) {
        // Legacy background build: probe the content listener with a snapshot.
        try {
          const probe = await cmd("snapshot", { tabId });
          if ((probe?.elements ?? 0) >= 2) return { mode: "legacy-snapshot" };
          last = `legacy snapshot probe returned ${probe?.elements} elements`;
        } catch (probeError) {
          last = probeError?.message || String(probeError);
        }
      }
    }
    await sleep(250);
  }
  throw new Error(`content-script-not-ready: ${last}`);
}

async function snapshot(tabId) {
  let last = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const snap = await cmd("snapshot", { tabId });
      if (snap && typeof snap.elements === "number" && typeof snap.tree === "string" && snap.elements >= 2) {
        return snap;
      }
      last = `bad snapshot shape: ${brief(snap)}`;
    } catch (error) {
      last = error?.message || String(error);
    }
    await sleep(250);
  }
  throw new Error(`snapshot did not return a usable tree: ${last}`);
}

async function closeTestTab() {
  if (!currentTabId || closed) return null;
  try {
    const result = await cmd("close_tab", { tabId: currentTabId });
    if (result?.closed === currentTabId) {
      closed = true;
      return result;
    }
  } catch {
    // Tab may already be gone; treat as closed.
    closed = true;
  }
  closed = true;
  return { closed: currentTabId };
}

async function main() {
  out(`# bridge verify client=${client}`);
  out(`# started ${new Date().toISOString()} node=${process.version}`);
  const idle = await waitForBridgeIdle(15000);
  out(`# bridge idle before run: ${idle}`);
  const health = await waitForClient(20000);
  record("extension connected", !!health, `clients=${health.last} lastSeenMsAgo=${health.lastSeenMsAgo} polls=${health.polls ?? "?"}`);

  // 1. new tab + navigate
  const tab = await retry("new_tab", () => cmd("new_tab", { url: "about:blank", active: true }), 3, 400);
  if (!tab?.id) throw new Error(`new_tab returned no tab id: ${brief(tab)}`);
  currentTabId = tab.id;
  record("open new tab", true, `tabId=${tab.id}`);
  try {
    const nav = await retry("navigate", () => cmd("navigate", { tabId: currentTabId, url: TEST_URL }), 3, 500);
    record("navigate", nav?.url === TEST_URL, nav?.title || nav?.url);
    await waitForPage(currentTabId);
    await ensureRendered(currentTabId);

    const ready = await waitContentReady(currentTabId);
    out(`# content readiness: ${brief(ready)}`);

    // 2. page info + tabs list
    const info = await cmd("page_info", { tabId: currentTabId });
    record("page_info", info?.title === TEST_TITLE, `title=${info?.title} viewport=${brief(info?.viewport)}`);
    const tabs = await cmd("list_tabs", {});
    record("list_tabs", Array.isArray(tabs) && tabs.some((t) => t.id === currentTabId), `tabs=${tabs?.length}`);

    // 3. snapshot with refs
    const snap = await snapshot(currentTabId);
    record("snapshot", true, `${snap.elements} elements url=${snap.url}`);
    const nameRef = /\[(r\d+)\] input[^\n]*placeholder="type your name"/.exec(snap.tree ?? "")?.[1];
    const goRef = /\[(r\d+)\] button "Go"/.exec(snap.tree ?? "")?.[1];
    if (!nameRef || !goRef) throw new Error(`refs missing from snapshot tree: ${brief(snap.tree, 400)}`);
    record("ref extraction", true, `name=${nameRef} go=${goRef}`);

    // 4. install visible-hand module
    const vision = await retry("vision install", async () => {
      const value = await js(await readFile(VISION, "utf8"));
      return value;
    }, 2, 400);
    const visionOk = typeof vision === "string" && vision.startsWith("vision-installed");
    record("visible hand module", visionOk, brief(vision));
    if (!visionOk) throw new Error(`vision module install failed: ${brief(vision)}`);

    // 5. visible fill (hand moves, then value set)
    const pointed = await js(
      `(() => { const v = window.__dshVision; if (!v) return "no-vision"; const el = v.find({selector:"#name"}); if (!el) return "target-not-found"; el.scrollIntoView({block:"center"}); v.pointerTo(el, "填写"); v.flash(el); return "pointed"; })()`,
    );
    if (pointed !== "pointed") throw new Error(`hand could not point at #name: ${brief(pointed)}`);
    await sleep(300);
    let filled = null;
    let fillError = null;
    for (let i = 0; i < 5; i += 1) {
      try {
        filled = await cmd("fill", { tabId: currentTabId, selector: "#name", text: "Wesley" });
        if (filled?.filled?.value === "Wesley") break;
      } catch (error) {
        fillError = error?.message || String(error);
      }
      await sleep(300);
    }
    record("fill (visible hand)", filled?.filled?.value === "Wesley", fillError || `value=${brief(filled?.filled?.value)}`);
    await screenshot(join(EVIDENCE, `verify-${client}-fill.png`));

    // 6. visible click (hand moves, then click)
    const pointed2 = await js(
      `(() => { const v = window.__dshVision; if (!v) return "no-vision"; const el = v.find({selector:"#go"}); if (!el) return "target-not-found"; el.scrollIntoView({block:"center"}); v.pointerTo(el, "点击"); v.flash(el); return "pointed"; })()`,
    );
    if (pointed2 !== "pointed") throw new Error(`hand could not point at #go: ${brief(pointed2)}`);
    await sleep(400);
    let statusText = null;
    let clickError = null;
    for (let i = 0; i < 5; i += 1) {
      try {
        await cmd("click", { tabId: currentTabId, selector: "#go" });
        statusText = await cmd("read", { tabId: currentTabId, selector: "#status" });
        if (/clicked:Wesley/.test(statusText?.text ?? "")) break;
      } catch (error) {
        clickError = error?.message || String(error);
      }
      await sleep(300);
    }
    await sleep(250);
    if (!/clicked:Wesley/.test(statusText?.text ?? "")) {
      throw new Error(clickError || `status text is ${brief(statusText?.text)}`);
    }
    record("click (visible hand)", true, brief(statusText?.text));
    await screenshot(join(EVIDENCE, `verify-${client}-click.png`));

    // 7. visible read (hand scans blocks)
    await js(`(() => { window.__dshVision.startRead({ maxBlocks: 6, delayMs: 260 }); return "started"; })()`);
    let reading = null;
    for (let i = 0; i < 80; i += 1) {
      const state = await js(
        `(() => { const v = window.__dshVision; if (!v || !v.state) return "no-vision"; if (v.state.error) return "error:" + v.state.error; if (!v.state.done) return "pending"; return JSON.stringify(v.state.result); })()`,
      );
      if (state === "pending") {
        await sleep(400);
        continue;
      }
      try {
        reading = JSON.parse(state);
      } catch {
        reading = { error: state };
      }
      break;
    }
    record("hand_read (visible scan)", !!reading && (reading.blocks ?? 0) >= 2, `${reading?.blocks ?? 0} blocks`);
    await screenshot(join(EVIDENCE, `verify-${client}-read.png`));

    // 8. js / scroll / wait_selector / wait_url
    const title = await js("document.title");
    record("js evaluate", title === TEST_TITLE, String(title));

    const scrolled = await cmd("scroll", { tabId: currentTabId, deltaY: 40 });
    record("scroll", typeof scrolled?.scroll?.y === "number", `y=${scrolled?.scroll?.y}`);

    let waited = await cmd("wait_for_selector", { tabId: currentTabId, selector: "#title", timeoutMs: 3000 });
    let selectorState = "visible";
    if (waited?.found !== true) {
      waited = await cmd("wait_for_selector", { tabId: currentTabId, selector: "#title", state: "attached", timeoutMs: 3000 });
      selectorState = "attached";
    }
    record("wait_for_selector", waited?.found === true, `found=${waited?.found} state=${selectorState}`);

    const waitedUrl = await cmd("wait_for_url", { tabId: currentTabId, pattern: "127\\.0\\.0\\.1:18765", timeoutMs: 3000 });
    record("wait_for_url", waitedUrl?.matched === true, `matched=${waitedUrl?.matched}`);

    // 9. screenshot
    const shot = await screenshot(join(EVIDENCE, `verify-${client}-final.png`));
    record("screenshot", true, shot);

    // 10. close tab
    const closeResult = await closeTestTab();
    record("close tab", closeResult?.closed === tab.id, `closed=${closeResult?.closed}`);
  } catch (error) {
    out(`VERIFY ERROR: ${error?.stack || error}`);
    record("aborted", false, String(error?.message || error));
  } finally {
    if (!closed) {
      try {
        await closeTestTab();
      } catch {}
    }
  }

  const passed = results.filter((r) => r.ok).length;
  out(`\nSUMMARY ${client}: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
  await mkdir(EVIDENCE, { recursive: true }).catch(() => {});
  await writeFile(LOG_PATH, `${logLines.join("\n")}\n`, "utf8");
  out(`# log saved: ${LOG_PATH}`);
}

main().catch(async (error) => {
  out(`VERIFY FATAL: ${error?.stack || error}`);
  record("fatal", false, String(error?.message || error));
  const passed = results.filter((r) => r.ok).length;
  out(`\nSUMMARY ${client}: ${passed}/${results.length} passed`);
  process.exitCode = 1;
  try {
    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(LOG_PATH, `${logLines.join("\n")}\n`, "utf8");
  } catch {}
});
