const REAL_TOOL_ACTIONS = Object.freeze({
  ego_snapshot: "snapshot",
  ego_navigate: "navigate",
  ego_click: "click",
  ego_fill: "fill",
  ego_js: "js",
  ego_screenshot: "screenshot",
  ego_page_info: "page_info",
  ego_wait_for_selector: "wait_selector",
  ego_wait_for_url: "wait_url",
  ego_read_element: "read",
  ego_scroll: "scroll",
});

export function normalizeBrowserMode(value) {
  if (value === "agent" || value === "real-only" || value === "real") return value;
  return "real";
}

export function realActionForTool(toolName) {
  return REAL_TOOL_ACTIONS[toolName] ?? null;
}

export function hasConnectedRealClient(status) {
  return Object.values(status?.clients ?? {}).some((client) =>
    client && client.stale !== true && Number(client.lastSeenMsAgo) < 120000
  );
}

export function resolveBrowserRoute({
  toolName,
  mode = "real",
  realConnected = false,
  isolateSpaces = false,
  unattended = false,
}) {
  const normalizedMode = normalizeBrowserMode(mode);
  const action = realActionForTool(toolName);
  if (normalizedMode === "agent") {
    return { route: "agent", action, fallback: false, reason: "agent mode was explicitly selected" };
  }
  if (!action) {
    return { route: "agent", action: null, fallback: false, reason: "tool requires agent-browser capabilities" };
  }
  if (isolateSpaces || unattended) {
    return { route: "agent", action, fallback: false, reason: isolateSpaces ? "isolated spaces require agent mode" : "unattended execution requires agent mode" };
  }
  if (realConnected) {
    return { route: "real", action, fallback: false, reason: "real browser bridge is connected" };
  }
  if (normalizedMode === "real-only") {
    return { route: "real", action, fallback: false, reason: "real-only mode requires a connected real browser bridge" };
  }
  return { route: "agent", action, fallback: true, reason: "real browser bridge is not connected; safely falling back to agent browser" };
}

export function realArgsForTool(toolName, args = {}) {
  switch (toolName) {
    case "ego_navigate":
      return { url: args.url, timeoutMs: args.timeout };
    case "ego_click":
      return { selector: args.selector, x: args.x, y: args.y, double: args.double, label: args.label };
    case "ego_fill":
      return { selector: args.selector, text: args.text };
    case "ego_js":
      return { expression: args.expression };
    case "ego_screenshot":
      return { selector: args.selector };
    case "ego_wait_for_selector":
      return { selector: args.selector, timeoutMs: args.timeout };
    case "ego_wait_for_url":
      return { pattern: args.pattern, timeoutMs: args.timeout };
    case "ego_read_element":
      return { selector: args.selector };
    case "ego_scroll":
      return { selector: args.selector, deltaX: args.deltaX, deltaY: args.deltaY };
    default:
      return {};
  }
}
