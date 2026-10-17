/**
 * Real-browser mode for dsh-ego-local-browser.
 *
 * Instead of the cloned-profile "agent browser", this add-on drives the user's
 * OWN taskbar browser (Chrome or Edge, real profile, real logins) through the
 * bundled MV3 extension + loopback bridge. Nothing is copied, no remote
 * debugging port is opened on the real profile, and every action is VISIBLE in
 * the user's window: the whale-maid cursor points at the element, the element
 * flashes pink, pages scroll smoothly while "reading".
 *
 * Tools registered here:
 *   ego_real         — one multi-action tool (status/tabs/open/navigate/...)
 *   ego_real_doctor  — bridge + extension + browser presence diagnostics
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_PORT = Number(process.env.EGO_REAL_BRIDGE_PORT || 18765);
const BRIDGE_TOKEN = "dsh-bridge-local";
const BRIDGE_ID = "dsh-real-browser-bridge";
const OWNER_LEASE_MS = 5000;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const TOOL_TIMEOUT_MS = 120000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDON_DIR = join(__dirname, "..", "real-browser");
const SERVER_PATH = join(ADDON_DIR, "bridge", "server.mjs");
const VISION_PATH = join(ADDON_DIR, "bridge", "vision.js");
const EXTENSION_DIR = join(ADDON_DIR, "extension");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

function homeDir() {
  return process.env.EGO_LOCAL_HOME || "E:\\AI\\DeepSeek\\data\\dsh-ego-local-browser";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findBinary(candidates) {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

let bridgeStarting = null;
/** The bridge child this host spawned (null when another owner started it). */
let bridgeChild = null;
const ownerNonce = randomUUID();
let heartbeatTimer = null;
let ownsBridge = false;

async function bridgeStatus() {
  try {
    const response = await fetch(`${BASE}/status?token=${BRIDGE_TOKEN}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function realBrowserStatus() {
  const status = await bridgeStatus();
  return status?.bridgeId === BRIDGE_ID ? status : null;
}

function validBridgeStatus(status) {
  return status?.ok === true && status.bridgeId === BRIDGE_ID;
}

async function heartbeat() {
  if (!ownsBridge) return;
  try {
    const response = await fetch(`${BASE}/heartbeat?token=${BRIDGE_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerNonce }),
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) {
      ownsBridge = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  } catch {
    ownsBridge = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeat, Math.max(500, Math.floor(OWNER_LEASE_MS / 2)));
  heartbeatTimer.unref?.();
}

async function ensureBridge(ctx) {
  const existing = await bridgeStatus();
  if (validBridgeStatus(existing)) {
    if (existing.ownerNonce && existing.ownerNonce !== ownerNonce) return false;
    ownsBridge = existing.ownerNonce === ownerNonce;
    if (ownsBridge) startHeartbeat();
    return true;
  }
  if (!bridgeStarting) {
    bridgeStarting = (async () => {
      if (!existsSync(SERVER_PATH)) throw new Error(`bridge server missing: ${SERVER_PATH}`);
      const child = spawn(process.execPath, [SERVER_PATH, String(BRIDGE_PORT)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, DSH_BRIDGE_PORT: String(BRIDGE_PORT), DSH_BRIDGE_OWNER_NONCE: ownerNonce }
      });
      bridgeChild = child;
      child.once("exit", () => {
        if (bridgeChild === child) bridgeChild = null;
      });
      child.once("error", () => {
        if (bridgeChild === child) bridgeChild = null;
      });
      child.unref();
      for (let i = 0; i < 40; i += 1) {
        await sleep(250);
        const status = await bridgeStatus();
        if (validBridgeStatus(status) && status.ownerNonce === ownerNonce) {
          ownsBridge = true;
          startHeartbeat();
          return true;
        }
      }
      return false;
    })();
  }
  try {
    return await bridgeStarting;
  } finally {
    bridgeStarting = null;
  }
}

async function call(cmd, args = {}, timeoutMs = TOOL_TIMEOUT_MS) {
  // Routing must be a top-level field: the bridge delivers a command only to the
  // poll matching the requested client. Leaving it inside args made commands
  // land on whichever browser polled first (page_info on Chrome, js on Edge ->
  // "No tab with id").
  const { client, ...rest } = args || {};
  const response = await fetch(`${BASE}/enqueue?token=${BRIDGE_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args: rest, client, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 15000)
  });
  const json = await response.json().catch(() => null);
  if (!json) throw new Error(`bridge: empty response for ${cmd}`);
  if (json.ok !== true) throw new Error(`bridge: ${json.error || `command ${cmd} failed`}`);
  return json.value;
}

function jsExpression(expression) {
  return call("js", { expression, ...jsExpression.tabArgs });
}

function withTab(args) {
  const params = {};
  if (typeof args.tab === "number") params.tabId = args.tab;
  if (args.client === "chrome" || args.client === "edge") params.client = args.client;
  jsExpression.tabArgs = params;
  return params;
}

async function ensureVision(args) {
  const code = await readFile(VISION_PATH, "utf8");
  const result = await call("js", { expression: code, ...withTab(args) });
  return typeof result === "string" && result.startsWith("vision-installed");
}

function targetSpec(args) {
  return JSON.stringify({
    ref: args.ref ?? null,
    selector: args.selector ?? null,
    text: args.text ?? null
  });
}

async function pointAt(args, label) {
  const spec = targetSpec(args);
  return await call("js", {
    expression: `(() => { const v = window.__dshVision; if (!v) return "no-vision"; const el = v.find(${spec}); if (!el) return "target-not-found"; el.scrollIntoView({ block: "center", behavior: "smooth" }); v.pointerTo(el, ${JSON.stringify(label)}); v.flash(el); return "pointed"; })()`,
    ...withTab(args)
  });
}

function likelyLoginPage(url, title, tree) {
  const haystack = `${url || ""} ${title || ""}`;
  const looksAuth = /(?:sign[-_ ]?in|log[-_ ]?in|sso|auth|okta|saml|account)/i.test(haystack);
  const hasPassword = typeof tree === "string" && /type=password/.test(tree);
  return looksAuth || hasPassword;
}

async function saveScreenshot(value) {
  const dataUrl = typeof value === "string" ? value : value?.dataUrl;
  if (!dataUrl) return null;
  const dir = join(homeDir(), "real-browser-shots");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `real-${Date.now()}.png`);
  await writeFile(path, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
  return path;
}

async function waitForTab(client, urlFragment, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await call("list_tabs", { client });
    const hit = (tabs || []).find((tab) => typeof tab.url === "string" && tab.url.includes(urlFragment) && tab.status === "complete");
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

async function runAction(action, args) {
  switch (action) {
    case "status": {
      const status = await bridgeStatus();
      const tabs = status ? await call("list_tabs", {}) : [];
      const clients = Object.keys(status?.clients ?? {});
      return {
        ok: true,
        bridgeRunning: !!status,
        bridgePort: BRIDGE_PORT,
        clients,
        tabs: (tabs || []).length,
        extensionDir: EXTENSION_DIR,
        hint: clients.length ? `connected: ${clients.join(", ")}` : `extension not connected: load ${EXTENSION_DIR} in the target browser (开发人员模式 → 加载已解压的扩展程序)`
      };
    }

    export async function executeRealBrowserAction(ctx, action, args = {}) {
      if (!(await ensureBridge(ctx))) {
        throw new Error("real-browser-unavailable: bridge is not running or the extension is not connected");
      }
      return runAction(action, args);
    }
    case "tabs":
      return { ok: true, tabs: await call("list_tabs", withTab(args)) };
    case "open": {
      const browser = args.browser === "edge" || args.browser === "chrome" ? args.browser : (args.browser === "auto" ? "auto" : "auto");
      const exe = browser === "edge" ? findBinary(EDGE_CANDIDATES) : browser === "chrome" ? findBinary(CHROME_CANDIDATES) : (findBinary(CHROME_CANDIDATES) || findBinary(EDGE_CANDIDATES));
      if (!exe) throw new Error("no Chrome/Edge binary found");
      const target = args.url || "about:blank";
      const child = spawn(exe, [target], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      const client = exe.toLowerCase().includes("msedge") ? "edge" : "chrome";
      const tab = await waitForTab(client, target.replace(/^https?:\/\//, "").split("?")[0], 20000);
      return {
        ok: true,
        browser: client,
        exe,
        pid: child.pid ?? null,
        url: target,
        tabId: tab?.id ?? null,
        note: "opened in YOUR real taskbar browser (real profile/logins), not the agent browser"
      };
    }
    case "navigate": {
      if (!args.url) throw new Error("navigate needs url");
      const value = await call("navigate", { ...withTab(args), url: args.url });
      return { ok: true, ...value };
    }
    case "page_info":
      return { ok: true, ...(await call("page_info", withTab(args))) };
    case "snapshot": {
      const value = await call("snapshot", withTab(args));
      const loggedIn = !likelyLoginPage(value?.url, value?.title, value?.tree);
      return { ok: true, ...value, likelyLoginPage: !loggedIn };
    }
    case "read": {
      const value = await call("read", { ...withTab(args), ref: args.ref, selector: args.selector });
      return { ok: true, ...value };
    }
    case "click": {
      const pointed = await pointAt(args, args.label || "点击");
      await sleep(350);
      const value = args.text
        ? await call("js", { expression: `(() => { const v = window.__dshVision; const el = v.find(${targetSpec(args)}); if (!el) return "target-not-found"; el.click(); return "clicked"; })()`, ...withTab(args) })
        : await call("click", { ...withTab(args), ref: args.ref, selector: args.selector, ...(typeof args.x === "number" ? { x: args.x, y: args.y } : {}) });
      return { ok: true, pointed, clicked: value };
    }
    case "fill": {
      const pointed = await pointAt(args, args.label || "填写");
      await sleep(300);
      const value = await call("fill", { ...withTab(args), ref: args.ref, selector: args.selector, text: String(args.text ?? "") });
      return { ok: true, pointed, filled: value };
    }
    case "js": {
      if (!args.expression) throw new Error("js needs expression");
      return { ok: true, value: await call("js", { expression: String(args.expression), ...withTab(args) }) };
    }
    case "scroll": {
      const value = await call("scroll", { ...withTab(args), deltaY: Number(args.deltaY ?? 600) });
      return { ok: true, ...value };
    }
    case "screenshot": {
      const value = await call("screenshot", withTab(args));
      const path = await saveScreenshot(value);
      return { ok: true, path, url: value?.url, title: value?.title };
    }
    case "wait_selector":
      return { ok: true, ...(await call("wait_for_selector", { ...withTab(args), selector: args.selector, timeoutMs: Number(args.timeoutMs ?? 10000) })) };
    case "wait_url":
      return { ok: true, ...(await call("wait_for_url", { ...withTab(args), pattern: args.pattern, timeoutMs: Number(args.timeoutMs ?? 10000) })) };
    case "hand_read": {
      await ensureVision(args);
      await call("js", { expression: `(() => { const v = window.__dshVision; v.startRead({ maxBlocks: ${Number(args.maxBlocks ?? 40)}, delayMs: ${Number(args.delayMs ?? 220)} }); return "started"; })()`, ...withTab(args) });
      const pollExpr = `(() => { const v = window.__dshVision; if (!v || !v.state) return "no-vision"; if (v.state.error) return "error:" + v.state.error; if (!v.state.done) return "pending"; return JSON.stringify(v.state.result); })()`;
      for (let i = 0; i < 150; i += 1) {
        const state = await call("js", { expression: pollExpr, ...withTab(args) });
        if (state === "pending") {
          await sleep(500);
          continue;
        }
        if (typeof state === "string" && state.startsWith("error:")) return { ok: false, error: state.slice(6) };
        return { ok: true, reading: JSON.parse(state) };
      }
      return { ok: false, error: "read-timeout" };
    }
    case "hand_click":
    case "hand_fill": {
      await ensureVision(args);
      const pointed = await pointAt(args, action === "hand_click" ? "点击" : "填写");
      await sleep(380);
      let value;
      if (action === "hand_click") {
        value = args.text
          ? await call("js", { expression: `(() => { const v = window.__dshVision; const el = v.find(${targetSpec(args)}); if (!el) return "target-not-found"; el.click(); return "clicked"; })()`, ...withTab(args) })
          : await call("click", { ...withTab(args), ref: args.ref, selector: args.selector });
      } else {
        value = await call("fill", { ...withTab(args), ref: args.ref, selector: args.selector, text: String(args.text ?? "") });
      }
      const shot = args.screenshot === false ? null : await saveScreenshot(await call("screenshot", withTab(args)));
      return { ok: true, pointed, result: value, screenshot: shot };
    }
    case "extension":
      return {
        ok: true,
        extensionDir: EXTENSION_DIR,
        steps: [
          "Chrome 地址栏打开 chrome://extensions/",
          "右上角开启 开发者模式",
          "点击 加载已解压的扩展程序，选择 extensionDir",
          "Edge 同理：edge://extensions/ → 开发人员模式 → 加载解压缩的扩展"
        ]
      };
    default:
      throw new Error(`unknown ego_real action: ${action}`);
  }
}

function renderText(_args, value) {
  if (value !== null && typeof value === "object" && value.ok === true && typeof value.text === "string") {
    return [{ type: "text", text: value.text }];
  }
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

const ACTIONS = [
  "status", "tabs", "open", "navigate", "page_info", "snapshot", "read", "click", "fill",
  "js", "scroll", "screenshot", "wait_selector", "wait_url", "hand_read", "hand_click",
  "hand_fill", "extension"
];

/**
 * Stop the bridge child this plugin host started, if any.
 *
 * The bridge also exits by itself when its owner process dies (server.mjs owner
 * watchdog); killing it here makes plugin dispose deterministic, so an HMR
 * reload or profile shutdown never leaves a hidden bridge behind holding the
 * DeepSeek Harness.exe image (which blocks NSIS updates).
 */
export function stopRealBrowserBridge() {
  ownsBridge = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const child = bridgeChild;
  bridgeChild = null;
  if (!child || child.exitCode !== null) return false;
  try {
    child.kill();
    return true;
  } catch {
    return false;
  }
}

export function registerRealBrowserTools(ctx, cfg, reg) {
  // Cordis runs the effect callback immediately and keeps the returned function
  // as the disposer. The outer `() => () => ...` shape is what makes plugin
  // dispose / HMR actually kill the bridge child (a bare `() => { stop... }`
  // would just call it once at registration and register nothing).
  ctx.effect?.(() => () => {
    stopRealBrowserBridge();
  });
  reg(defineTool({
    name: "ego_real",
    description:
      "Drive the user's OWN taskbar browser (their real Chrome or Edge window, real profile and logins) through the bundled MV3 extension bridge — never the cloned agent browser. " +
      "Actions: status, tabs, open (launch the browser from the taskbar like the user would), navigate, page_info, snapshot (semantic tree with [ref]s), read, click, fill, js, scroll, screenshot, wait_selector, wait_url, hand_read (visible whale-maid cursor scans the page while reading), hand_click, hand_fill, extension (where to load the extension). " +
      "Every action is visible in the user's browser: the whale-maid (鲸鱼娘) cursor points at the target, elements flash pink, pages scroll smoothly. " +
      "If snapshot reports likelyLoginPage=true or the page asks for a password/2FA, STOP and ask the user to log in themselves — never try to log in automatically. 真实浏览器（任务栏里的 Chrome/Edge）操作工具。",
    parameters: {
      action: {
        type: "string",
        description: ACTIONS.join(" | "),
        required: true
      },
      client: {
        type: "string",
        description: "Which real browser to target: chrome or edge (default: whichever is connected / most recently used)"
      },
      tab: {
        type: "number",
        description: "Target tab id (from action=tabs); omit to use the active tab"
      },
      url: { type: "string", description: "URL for open/navigate" },
      browser: { type: "string", description: "open: chrome | edge | auto" },
      ref: { type: "string", description: "Element ref from a fresh snapshot, e.g. r12" },
      selector: { type: "string", description: "CSS selector alternative to ref" },
      text: { type: "string", description: "fill text, or click-by-visible-text" },
      expression: { type: "string", description: "JS expression for action=js" },
      deltaY: { type: "number", description: "scroll delta" },
      maxBlocks: { type: "number", description: "hand_read: max text blocks to visit" },
      delayMs: { type: "number", description: "hand_read: ms to pause per block" },
      pattern: { type: "string", description: "wait_url: URL regex/glob substring" },
      timeoutMs: { type: "number", description: "wait_* timeout" },
      x: { type: "number", description: "click viewport x" },
      y: { type: "number", description: "click viewport y" },
      label: { type: "string", description: "label shown next to the whale cursor" }
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
      render: renderText
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args) => {
      try {
        if (!(await ensureBridge(ctx))) {
          return {
            ok: false,
            error: "real-browser bridge is not running and could not be started",
            hint: `run node "${SERVER_PATH}" manually; extension dir: ${EXTENSION_DIR}`
          };
        }
        const value = await runAction(String(args.action), args || {});
        return value;
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `ego_real: ${String(args?.action ?? "status")}`,
      kind: "other",
      rawInput: null
    })
  }));

  reg(defineTool({
    name: "ego_real_doctor",
    description: "Real-browser mode diagnostics: bridge server health, connected extension clients (chrome/edge), extension directory to load, detected browser binaries, and a reminder that this mode never copies profiles or reads cookies. 真实浏览器桥接体检。",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
      render: renderText
    },
    timeoutMs: 30000,
    execute: async () => {
      try {
        const status = await bridgeStatus();
        const clients = Object.keys(status?.clients ?? {});
        return {
          ok: true,
          bridgeRunning: !!status,
          bridgePort: BRIDGE_PORT,
          clients,
          extensionDir: EXTENSION_DIR,
          visionPath: VISION_PATH,
          chrome: findBinary(CHROME_CANDIDATES),
          edge: findBinary(EDGE_CANDIDATES),
          policy: "uses the user's real taskbar browser only; no profile copy, no cookie reading, no auto-login"
        };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    presentCall: () => ({ card: "generic", title: "ego_real_doctor", kind: "other", rawInput: null })
  }));
}
