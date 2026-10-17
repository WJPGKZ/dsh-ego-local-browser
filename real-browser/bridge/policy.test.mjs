import test from "node:test";
import assert from "node:assert/strict";
import { hasConnectedRealClient, realActionForTool, resolveBrowserRoute } from "../../lib/browser-policy.mjs";

test("default routes supported page tools to real browser when connected", () => {
  assert.equal(realActionForTool("ego_click"), "click");
  assert.deepEqual(resolveBrowserRoute({
    toolName: "ego_click",
    realConnected: true,
  }), {
    route: "real",
    action: "click",
    fallback: false,
    reason: "real browser bridge is connected",
    clientRole: "real",
    clientSelection: "connected real browser client",
  });
});

test("real mode does not select an agent-only client", () => {
  const clients = { chrome: { role: "agent" } };
  const realConnected = hasConnectedRealClient({ clients });
  assert.equal(realConnected, false);
  assert.deepEqual(resolveBrowserRoute({
    toolName: "ego_click",
    mode: "real",
    realConnected,
  }), {
    route: "agent",
    action: "click",
    fallback: true,
    reason: "real browser bridge is not connected; safely falling back to agent browser",
    clientRole: "agent",
    clientSelection: "no connected real client; fallback",
  });
});

test("agent mode is forced without fallback", () => {
  assert.deepEqual(resolveBrowserRoute({
    toolName: "ego_click",
    mode: "agent",
    realConnected: true,
  }), {
    route: "agent",
    action: "click",
    fallback: false,
    reason: "agent mode was explicitly selected",
    clientRole: "agent",
    clientSelection: "browserMode=agent",
  });
});

test("disconnected real browser falls back explicitly to agent", () => {
  const route = resolveBrowserRoute({ toolName: "ego_snapshot" });
  assert.equal(route.route, "agent");
  assert.equal(route.fallback, true);
  assert.match(route.reason, /not connected/);
});

test("real-only and isolated/unattended execution never silently mixes modes", () => {
  assert.equal(resolveBrowserRoute({
    toolName: "ego_fill",
    mode: "real-only",
  }).route, "real");
  assert.equal(resolveBrowserRoute({
    toolName: "ego_fill",
    mode: "real-only",
  }).fallback, false);
  assert.equal(resolveBrowserRoute({
    toolName: "ego_fill",
    realConnected: true,
    isolateSpaces: true,
  }).route, "agent");
  assert.equal(resolveBrowserRoute({
    toolName: "ego_fill",
    realConnected: true,
    unattended: true,
  }).route, "agent");
});

test("unsupported tools remain agent-only", () => {
  const route = resolveBrowserRoute({ toolName: "ego_cdp", realConnected: true });
  assert.equal(route.route, "agent");
  assert.equal(route.fallback, false);
});

test("stale real-browser clients do not count as connected", () => {
  assert.equal(hasConnectedRealClient({
    clients: { chrome: { stale: true, lastSeenMsAgo: 10 } },
  }), false);
  assert.equal(hasConnectedRealClient({
    clients: { edge: { stale: false, lastSeenMsAgo: 1000 } },
  }), true);
});
