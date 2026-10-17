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
