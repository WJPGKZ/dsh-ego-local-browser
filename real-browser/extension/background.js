/**
 * DSH Local Browser Bridge — extension service worker.
 *
 * Long-polls http://127.0.0.1:18765/poll for agent commands, executes them on the
 * user's real browser tabs, and posts results back. No remote-debugging port, no
 * profile copying: this runs inside the user's normal Chrome/Edge profile.
 *
 * Failure model (this is what the "undefined elements" bug was about):
 * - content-script commands never return `undefined`: every response is validated
 *   against the {ok:true,value} / {ok:false,error} contract and a violation is
 *   reported as an explicit error instead of a success-shaped empty value;
 * - a missing content script is repaired with a bounded ping/ready/inject retry
 *   loop instead of a single fixed 150 ms retry;
 * - the poll loop uses bounded long-polls (server holds 8 s) so a dead or
 *   restarting service worker cannot leave a request wedged forever.
 */
const BRIDGE = "http://127.0.0.1:18765";
const TOKEN = "dsh-bridge-local";
const CLIENT = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
const SOURCE = "dsh-local-browser-bridge";
/** Bump together with content.js; used by the readiness handshake. */
const PROTOCOL = 2;
const CONTENT_READY_TIMEOUT_MS = 8000;
const POLL_TIMEOUT_MS = 9500;
/** MV3 service workers die after ~30s without an extension event/API call.
 *  A pending fetch() does NOT reset that timer, so nudge the idle timer with a
 *  cheap extension API call well inside the window. Content scripts send a
 *  keepalive runtime message too (that also wakes a sleeping worker). */
const KEEPALIVE_INTERVAL_MS = 20000;

let polling = false;
let lastError = null;
let lastApiKeepaliveAt = 0;

function log(...args) {
  console.log("[dsh-bridge]", ...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reset the MV3 idle timer with a cheap extension API call. Without this a
 * service worker that is only waiting on a long-poll fetch() can be terminated
 * after ~30s of "inactivity" (fetch does not count as activity), which made
 * commands sit in the bridge queue until an alarm woke the worker (~30-90s).
 */
async function apiKeepalive() {
  if (Date.now() - lastApiKeepaliveAt < KEEPALIVE_INTERVAL_MS) return;
  lastApiKeepaliveAt = Date.now();
  try {
    await chrome.runtime.getPlatformInfo();
  } catch {}
}

// Content scripts send this every 20s. The message itself wakes a sleeping
// service worker (messages count as activity), so a dead worker recovers fast.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "dsh-bridge-keepalive") {
    sendResponse({ ok: true, client: CLIENT, at: Date.now() });
  }
  return false;
});

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length > 0) return tabs[0];
  const any = await chrome.tabs.query({ active: true });
  return any[0] ?? null;
}

async function targetTab(args) {
  if (args && args.tabId !== undefined && args.tabId !== null) {
    const id = Number(args.tabId);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid tabId: ${args.tabId}`);
    try {
      return await chrome.tabs.get(id);
    } catch {
      throw new Error(`stale-tab: no tab with id ${id}`);
    }
  }
  const tab = await activeTab();
  if (!tab) throw new Error("no active tab");
  return tab;
}

/* ------------------------------------------------------------------ *
 * content-script readiness handshake
 * ------------------------------------------------------------------ */

/**
 * Ping the tab's content script.
 * -> {state:"ready", info}   current content.js answered with the protocol version
 * -> {state:"legacy"}        an older content.js is alive (answers "unknown content command: ping")
 * -> {state:"missing", reason} nothing listening (or an invalid/undefined response)
 */
async function pingContent(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { source: SOURCE, cmd: "ping", args: {} }, { frameId: 0 });
    if (response && response.ok === true && response.value && response.value.protocol === PROTOCOL) {
      return { state: "ready", info: response.value };
    }
    if (response && response.ok === false && /unknown content command/i.test(String(response.error || ""))) {
      return { state: "legacy" };
    }
    return { state: "missing", reason: `invalid ping response: ${JSON.stringify(response)?.slice(0, 200)}` };
  } catch (error) {
    return { state: "missing", reason: String(error?.message || error) };
  }
}

/**
 * Make sure a content script is alive in the tab's main frame, repairing a
 * missing one with bounded injections. Throws content-script-not-ready after
 * CONTENT_READY_TIMEOUT_MS.
 */
async function ensureContent(tab) {
  const deadline = Date.now() + CONTENT_READY_TIMEOUT_MS;
  let reason = "content script not reachable";
  let injections = 0;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const ping = await pingContent(tab);
    if (ping.state === "ready" || ping.state === "legacy") return ping;
    reason = ping.reason;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["content.js"] });
      injections += 1;
    } catch (error) {
      reason = `injection failed: ${error?.message || error}`;
      // A restricted page (chrome://, web store, ...) will never accept this.
      if (/cannot access|not allowed|chrome:\/\/|extensions gallery|invalid tab/i.test(reason)) break;
    }
    const delay = [40, 80, 160, 320, 640, 1000][Math.min(attempt, 5)];
    if (Date.now() + delay >= deadline) break;
    await sleep(delay);
  }
  throw new Error(`content-script-not-ready: ${reason} (injected ${injections}x)`);
}

/**
 * Send a command to the content script, validate the response envelope, and
 * return the inner value. Never resolves `undefined`.
 */
async function sendToContent(tab, cmd, args) {
  await ensureContent(tab);
  let lastError = "no attempt";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { source: SOURCE, cmd, args }, { frameId: 0 });
    } catch (error) {
      lastError = String(error?.message || error);
      // The document may have navigated between ping and send: repair and retry.
      try {
        await ensureContent(tab);
      } catch (readyError) {
        throw new Error(`content-command-failed: ${cmd}: ${readyError?.message || readyError} (last error: ${lastError})`);
      }
      await sleep(60);
      continue;
    }
    if (response && typeof response === "object" && response.ok === true) {
      if (!("value" in response)) {
        throw new Error(`content-command-failed: ${cmd}: content script returned success without a value`);
      }
      return response.value;
    }
    if (response && typeof response === "object" && response.ok === false) {
      throw new Error(String(response.error || `content-command-failed: ${cmd}: unknown content-script error`));
    }
    lastError = `invalid response (${JSON.stringify(response)?.slice(0, 200)})`;
    await sleep(80);
  }
  throw new Error(`content-command-failed: ${cmd}: ${lastError}`);
}

/* ------------------------------------------------------------------ *
 * executeScript-backed commands
 * ------------------------------------------------------------------ */

async function pageInfo(tab) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: () => ({
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY, pageHeight: document.body ? document.body.scrollHeight : 0 },
      bodyLength: (document.body?.innerText || "").length,
    }),
  });
  return result?.result ?? null;
}

async function evaluate(tab, expression) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: (expr) => {
      // eslint-disable-next-line no-eval
      const value = eval(expr);
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    },
    args: [String(expression ?? "")],
  });
  return result?.result ?? null;
}

async function activateTab(tab) {
  const window = await chrome.windows.get(tab.windowId);
  if (window.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/* ------------------------------------------------------------------ *
 * commands
 * ------------------------------------------------------------------ */

const commands = {
  async ping(args) {
    const tab = await targetTab(args);
    const state = await ensureContent(tab);
    if (state.state === "legacy") return { protocol: 0, legacy: true, url: tab.url, title: tab.title };
    return state.info;
  },
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    const active = await activeTab();
    return tabs.map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      active: active?.id === tab.id,
      title: tab.title,
      url: tab.url,
      status: tab.status,
    }));
  },
  async activate(args) {
    const tab = await targetTab({ tabId: Number(args.tabId) });
    await activateTab(tab);
    return { activated: tab.id, url: tab.url };
  },
  async new_tab(args) {
    const createOptions = { url: args.url || "about:blank", active: args.active !== false };
    if (Number.isInteger(Number(args.windowId)) && Number(args.windowId) > 0) createOptions.windowId = Number(args.windowId);
    const tab = await chrome.tabs.create(createOptions);
    return { id: tab.id, url: tab.url, windowId: tab.windowId };
  },
  async close_tab(args) {
    const tab = await targetTab(args);
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id };
  },
  async navigate(args) {
    if (!args.url) throw new Error("navigate needs url");
    const tab = await targetTab(args);
    await chrome.tabs.update(tab.id, { url: args.url });
    await waitTabComplete(tab.id, 30000);
    const updated = await chrome.tabs.get(tab.id);
    return { id: updated.id, url: updated.url, title: updated.title, status: updated.status };
  },
  async page_info(args) {
    const tab = await targetTab(args);
    return await pageInfo(tab);
  },
  async snapshot(args) {
    return await sendToContent(await targetTab(args), "snapshot", cleanArgs(args));
  },
  async click(args) {
    return await sendToContent(await targetTab(args), "click", cleanArgs(args));
  },
  async fill(args) {
    return await sendToContent(await targetTab(args), "fill", cleanArgs(args));
  },
  async read(args) {
    return await sendToContent(await targetTab(args), "read", cleanArgs(args));
  },
  async scroll(args) {
    return await sendToContent(await targetTab(args), "scroll", cleanArgs(args));
  },
  async wait_for_selector(args) {
    return await sendToContent(await targetTab(args), "waitForSelector", cleanArgs(args));
  },
  async wait_for_url(args) {
    return await sendToContent(await targetTab(args), "waitForUrl", cleanArgs(args));
  },
  async js(args) {
    const tab = await targetTab(args);
    return await evaluate(tab, args.expression ?? args.code ?? "");
  },
  async screenshot(args) {
    const tab = await targetTab(args);
    await activateTab(tab);
    await sleep(150);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { dataUrl, url: tab.url, title: tab.title };
      } catch (error) {
        lastError = error;
        await sleep(300);
      }
    }
    throw new Error(`screenshot-failed: ${lastError?.message || lastError}`);
  },
};

/** Content commands do not need the bridge-level tabId/client routing fields. */
function cleanArgs(args) {
  if (!args || typeof args !== "object") return {};
  const { tabId, client, ...rest } = args;
  return rest;
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") return resolve(tab);
      } catch {
        return resolve(null);
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(check, 250);
    };
    check();
  });
}

/**
 * Hard per-command deadline. A content script can stop responding (native
 * dialog, frozen renderer, navigation race); without a watchdog that promise
 * never settles and the whole poll loop stops delivering commands. Bounded
 * failures are recoverable; a wedged loop is not.
 */
function commandTimeoutMs(command) {
  const args = command?.args ?? {};
  if (command?.cmd === "wait_for_selector" || command?.cmd === "wait_for_url") {
    return Math.min(Number(args.timeoutMs) || 10000, 60000) + 10000;
  }
  if (command?.cmd === "navigate") return 45000;
  return 30000;
}

async function execute(command) {
  const handler = commands[command?.cmd];
  if (!handler) throw new Error(`unknown bridge command: ${command?.cmd}`);
  const deadline = commandTimeoutMs(command);
  let timer;
  const watchdog = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`command-timeout: ${command.cmd} did not finish within ${deadline}ms`)), deadline);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => handler(command.args ?? {})), watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

async function pollOnce() {
  const response = await fetch(`${BRIDGE}/poll?token=${TOKEN}&client=${CLIENT}`, {
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (response.status === 204) return false;
  if (!response.ok) throw new Error(`bridge poll http ${response.status}`);
  const command = await response.json();
  if (!command || !command.id) throw new Error("bridge poll returned a command without an id");
  let result;
  try {
    const value = await execute(command);
    result = { id: command.id, ok: true, value, client: CLIENT };
  } catch (error) {
    result = { id: command.id, ok: false, error: String(error?.message || error), client: CLIENT };
  }
  const posted = await fetch(`${BRIDGE}/result?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
  if (!posted.ok && posted.status !== 404) log("result post failed", posted.status);
  return true;
}

async function loop() {
  if (polling) return;
  polling = true;
  let backoff = 0;
  log("poll loop started", CLIENT, "protocol", PROTOCOL);
  for (;;) {
    try {
      await pollOnce();
      lastError = null;
      backoff = 0;
      // Bounded long-poll: immediately re-poll after a command, so a run of
      // commands is not delayed by a timer tick. The fetch itself is the
      // MV3 keepalive while it is in flight.
      await apiKeepalive();
      await sleep(0);
    } catch (error) {
      lastError = String(error?.message || error);
      backoff = backoff === 0 ? 500 : Math.min(backoff * 2, 5000);
      await sleep(backoff);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  log("installed, bridge:", BRIDGE, "client:", CLIENT);
  loop();
});
chrome.runtime.onStartup.addListener(() => loop());
if (chrome.alarms) {
  chrome.alarms.create("dsh-bridge-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => loop());
}
loop();
