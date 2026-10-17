/**
 * DSH Local Browser Bridge — CLI for the agent.
 *
 * Talks to bridge/server.mjs (default 127.0.0.1:18765) and prints JSON.
 * Usage examples:
 *   node bridge/cli.mjs status
 *   node bridge/cli.mjs tabs
 *   node bridge/cli.mjs navigate https://example.com
 *   node bridge/cli.mjs snapshot
 *   node bridge/cli.mjs click r3
 *   node bridge/cli.mjs click --selector="#submit"
 *   node bridge/cli.mjs fill r5 --text "hello"
 *   node bridge/cli.mjs js "document.title"
 *   node bridge/cli.mjs screenshot E:\path\shot.png
 */
import { readFile, writeFile } from "node:fs/promises";

const PORT = Number(process.env.DSH_BRIDGE_PORT ?? 18765);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "dsh-bridge-local";
const VISION_PATH = "E:\\AI\\DeepSeek\\workspace\\local-browser\\bridge\\vision.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function targetExpr() {
  return JSON.stringify({
    ref: positional[0] && positional[0].startsWith("r") ? positional[0] : (flags.ref ?? null),
    selector: flags.selector ?? null,
    text: flags.text0 ?? null,
  });
}

async function ensureVision() {
  const code = await readFile(VISION_PATH, "utf8");
  const result = await call("js", { expression: code });
  if (typeof result === "string" && result.startsWith("vision-installed")) return true;
  return false;
}

const [command, ...rest] = process.argv.slice(2);
if (!command) {
  console.error("usage: node bridge/cli.mjs <command> [args]");
  process.exit(2);
}

const VALUE_FLAGS = new Set(["tab", "selector", "text", "xy", "timeout", "out", "expression", "expr-file", "dy", "pattern", "client", "max-blocks", "delay", "shot", "ref", "text0", "ms"]);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
  if (match) {
    flags[match[1]] = match[2];
    continue;
  }
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name) && i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
      flags[name] = rest[++i];
    } else {
      flags[name] = true;
    }
    continue;
  }
  positional.push(arg);
}

function tabArg() {
  return flags.tab !== undefined ? { tabId: Number(flags.tab) } : {};
}

async function call(cmd, args = {}) {
  const response = await fetch(`${BASE}/enqueue?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args, client: flags.client }),
    signal: AbortSignal.timeout(120000),
  });
  const json = await response.json();
  if (!json || json.ok !== true) {
    console.error(JSON.stringify(json ?? { ok: false, error: "no response" }, null, 2));
    process.exit(1);
  }
  return json.value;
}

async function main() {
  switch (command) {
    case "status": {
      const response = await fetch(`${BASE}/status?token=${TOKEN}`);
      console.log(JSON.stringify(await response.json(), null, 2));
      return;
    }
    case "tabs":
      return dump(await call("list_tabs", tabArg()));
    case "activate":
      return dump(await call("activate", { tabId: Number(positional[0] ?? flags.tab) }));
    case "new":
      return dump(await call("new_tab", { url: positional[0] ?? "about:blank" }));
    case "close":
      return dump(await call("close_tab", { ...tabArg(), ...(positional[0] ? { tabId: Number(positional[0]) } : {}) }));
    case "navigate":
      if (!positional[0]) throw new Error("navigate needs a url");
      return dump(await call("navigate", { ...tabArg(), url: positional[0] }));
    case "page_info":
      return dump(await call("page_info", tabArg()));
    case "snapshot":
      return dump(await call("snapshot", tabArg()));
    case "click": {
      const args = { ...tabArg() };
      if (positional[0]) args.ref = positional[0];
      if (flags.selector) args.selector = flags.selector;
      if (flags.xy) {
        const [x, y] = String(flags.xy).split(",").map(Number);
        args.x = x;
        args.y = y;
      }
      if (flags.double) args.double = true;
      return dump(await call("click", args));
    }
    case "fill": {
      const args = { ...tabArg() };
      if (positional[0]) args.ref = positional[0];
      if (flags.selector) args.selector = flags.selector;
      args.text = flags.text ?? positional[1] ?? "";
      if (flags.submit) args.submit = true;
      return dump(await call("fill", args));
    }
    case "read": {
      const args = { ...tabArg() };
      if (positional[0]) args.ref = positional[0];
      if (flags.selector) args.selector = flags.selector;
      return dump(await call("read", args));
    }
    case "js": {
      let expression = positional[0] ?? flags.expression ?? "";
      if (flags["expr-file"]) expression = await readFile(flags["expr-file"], "utf8");
      return dump(await call("js", { ...tabArg(), expression }));
    }
    case "scroll":
      return dump(await call("scroll", { ...tabArg(), deltaY: Number(positional[0] ?? flags.dy ?? 600) }));
    case "wait_selector":
      return dump(await call("wait_for_selector", { ...tabArg(), selector: positional[0] ?? flags.selector, timeoutMs: Number(flags.timeout ?? 10000) }));
    case "wait_url":
      return dump(await call("wait_for_url", { ...tabArg(), pattern: positional[0] ?? flags.pattern, timeoutMs: Number(flags.timeout ?? 10000) }));
    case "screenshot": {
      const value = await call("screenshot", tabArg());
      const path = positional[0] ?? flags.out;
      if (path && value?.dataUrl) {
        const base64 = String(value.dataUrl).replace(/^data:image\/png;base64,/, "");
        await writeFile(path, Buffer.from(base64, "base64"));
        console.log(JSON.stringify({ ok: true, path, url: value.url, title: value.title }, null, 2));
      } else {
        console.log(JSON.stringify(value, null, 2));
      }
      return;
    }
    case "hand_read": {
      await ensureVision();
      const maxBlocks = Number(flags["max-blocks"] ?? 60);
      const delay = Number(flags.delay ?? 180);
      const started = await call("js", { expression: `(() => { const v = window.__dshVision; if (!v) return "no-vision"; v.startRead({ maxBlocks: ${maxBlocks}, delayMs: ${delay} }); return "started"; })()` });
      dump({ started });
      if (flags.shot) {
        await sleep(1500);
        const shot = await call("screenshot", tabArg());
        if (shot && shot.dataUrl) {
          await writeFile(String(flags.shot), Buffer.from(String(shot.dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
          console.error(`mid-read screenshot saved: ${flags.shot}`);
        }
      }
      const pollExpr = `(() => { const v = window.__dshVision; if (!v || !v.state) return "no-vision"; if (v.state.error) return "error:" + v.state.error; if (!v.state.done) return "pending"; return JSON.stringify(v.state.result); })()`;
      for (let i = 0; i < 120; i += 1) {
        const state = await call("js", { expression: pollExpr });
        if (typeof state === "string" && state === "pending") {
          await sleep(700);
          continue;
        }
        if (typeof state === "string" && state.startsWith("error:")) {
          dump({ ok: false, error: state.slice(6) });
          process.exitCode = 1;
          return;
        }
        let parsed = null;
        try {
          parsed = JSON.parse(state);
        } catch {}
        dump({ ok: true, reading: parsed });
        return;
      }
      dump({ ok: false, error: "read-timeout" });
      process.exitCode = 1;
      return;
    }
    case "hand_click": {
      await ensureVision();
      if (flags.text && !flags.ref && !flags.selector && positional.length === 0) flags.text0 = flags.text;
      const target = targetExpr();
      const pointed = await call("js", { expression: `(() => { const v = window.__dshVision; if (!v) return "no-vision"; const el = v.find(${target}); if (!el) return "target-not-found"; el.scrollIntoView({ block: "center", behavior: "smooth" }); v.pointerTo(el, "点击"); v.flash(el); return "pointed"; })()` });
      dump({ pointed });
      if (pointed !== "pointed") {
        process.exitCode = 1;
        return;
      }
      await sleep(420);
      if (flags.text0) {
        const clicked = await call("js", { expression: `(() => { const v = window.__dshVision; const el = v.find(${target}); if (!el) return "target-not-found"; el.click(); return "clicked"; })()` });
        dump({ clicked });
      } else {
        const args = { ...tabArg() };
        if (target.ref) args.ref = JSON.parse(target).ref;
        if (flags.selector) args.selector = flags.selector;
        dump(await call("click", args));
      }
      if (flags.shot) {
        await sleep(500);
        const shot = await call("screenshot", tabArg());
        if (shot && shot.dataUrl) {
          await writeFile(String(flags.shot), Buffer.from(String(shot.dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
          console.error(`action screenshot saved: ${flags.shot}`);
        }
      }
      return;
    }
    case "hand_fill": {
      await ensureVision();
      const target = targetExpr();
      const pointed = await call("js", { expression: `(() => { const v = window.__dshVision; if (!v) return "no-vision"; const el = v.find(${target}); if (!el) return "target-not-found"; el.scrollIntoView({ block: "center", behavior: "smooth" }); v.pointerTo(el, "填写"); v.flash(el); return "pointed"; })()` });
      dump({ pointed });
      if (pointed !== "pointed") {
        process.exitCode = 1;
        return;
      }
      await sleep(350);
      const args = { ...tabArg(), text: flags.text ?? positional[1] ?? "" };
      if (flags.selector) args.selector = flags.selector;
      if (flags.ref) args.ref = flags.ref;
      dump(await call("fill", args));
      if (flags.shot) {
        await sleep(300);
        const shot = await call("screenshot", tabArg());
        if (shot && shot.dataUrl) {
          await writeFile(String(flags.shot), Buffer.from(String(shot.dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
          console.error(`action screenshot saved: ${flags.shot}`);
        }
      }
      return;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function dump(value) {
  console.log(JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  process.exit(1);
});
