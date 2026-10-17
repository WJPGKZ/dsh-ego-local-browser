/**
 * DSH Local Browser Bridge — content script.
 * Runs in the page and implements DOM-level commands the background worker relays.
 * It never sends page content anywhere except the local bridge result the user's
 * agent asked for.
 */
(() => {
  if (window.__dshLocalBridgeInstalled) return;
  window.__dshLocalBridgeInstalled = true;
  window.__dshLocalBridgeProtocol = 2;
  const PROTOCOL = 2;
  const INSTALLED_AT = Date.now();

  let refCounter = 0;
  const REF_ATTR = "data-dsh-ref";
  const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION", "LABEL"]);
  const INTERACTIVE_ROLES = /^(button|link|checkbox|radio|tab|menuitem|option|combobox|textbox|switch|searchbox|slider)$/i;

  function clearRefs() {
    for (const el of document.querySelectorAll(`[${REF_ATTR}]`)) el.removeAttribute(REF_ATTR);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    return rect.bottom >= -200 && rect.top <= window.innerHeight + 400;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const placeholder = el.getAttribute("placeholder");
    const aria = el.getAttribute("aria-label");
    const type = el.getAttribute("type");
    const name = el.getAttribute("name");
    const value = el.tagName === "INPUT" ? String(el.value || "").slice(0, 60) : "";
    const href = el.tagName === "A" ? el.getAttribute("href") : null;
    return { tag, text, placeholder, aria, type, name, value, href };
  }

  function assignRef(el) {
    let ref = el.getAttribute(REF_ATTR);
    if (!ref) {
      refCounter += 1;
      ref = `r${refCounter}`;
      el.setAttribute(REF_ATTR, ref);
    }
    return ref;
  }

  function snapshot({ max = 400 } = {}) {
    clearRefs();
    refCounter = 0;
    const lines = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, null);
    const seen = new Set();
    while (walker.nextNode() && lines.length < max) {
      const el = walker.currentNode;
      if (seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      const role = el.getAttribute("role");
      const tag = el.tagName;
      const interactive = INTERACTIVE.has(tag) || (role && INTERACTIVE_ROLES.test(role)) || el.getAttribute("onclick") || el.tabIndex >= 0;
      if (!interactive) continue;
      if (tag === "INPUT" && el.getAttribute("type") === "hidden") continue;
      const ref = assignRef(el);
      const info = describe(el);
      const parts = [`[${ref}]`, info.tag];
      if (info.type) parts.push(`type=${info.type}`);
      if (info.text) parts.push(`"${info.text}"`);
      if (info.placeholder) parts.push(`placeholder="${info.placeholder}"`);
      if (info.aria) parts.push(`aria="${info.aria}"`);
      if (info.name) parts.push(`name="${info.name}"`);
      if (info.value) parts.push(`value="${info.value}"`);
      if (info.href) parts.push(`href=${info.href}`);
      lines.push(parts.join(" "));
    }
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY, pageHeight: document.body ? document.body.scrollHeight : 0 },
      bodyLength: (document.body?.innerText || "").length,
      elements: lines.length,
      tree: lines.join("\n"),
    };
  }

  function resolveTarget({ ref, selector }) {
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`selector not found: ${selector}`);
      return el;
    }
    if (ref) {
      const el = document.querySelector(`[${REF_ATTR}="${ref}"]`);
      if (!el) throw new Error(`ref not found (take a fresh snapshot): ${ref}`);
      return el;
    }
    throw new Error("pass ref or selector");
  }

  function click({ ref, selector, x, y, double }) {
    if (typeof x === "number" && typeof y === "number") {
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`nothing at (${x},${y})`);
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, view: window }));
      }
      if (double) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
      return { clicked: describe(el) };
    }
    const el = resolveTarget({ ref, selector });
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    el.click();
    if (double) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return { clicked: describe(el) };
  }

  function fill({ ref, selector, text, submit }) {
    const el = resolveTarget({ ref, selector });
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text ?? "");
    else el.value = text ?? "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      const form = el.closest("form");
      if (form) form.requestSubmit?.();
    }
    return { filled: describe(el) };
  }

  function read({ ref, selector }) {
    const el = resolveTarget({ ref, selector });
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").slice(0, 4000),
      value: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? String(el.value ?? "").slice(0, 2000) : null,
      html: el.outerHTML.slice(0, 4000),
      attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
      visible: isVisible(el),
    };
  }

  function scroll({ deltaY = 0, deltaX = 0, ref, selector }) {
    if (ref || selector) {
      resolveTarget({ ref, selector }).scrollIntoView({ block: "center" });
    } else {
      window.scrollBy({ top: deltaY, left: deltaX, behavior: "instant" });
    }
    return { scroll: { x: window.scrollX, y: window.scrollY, pageHeight: document.body ? document.body.scrollHeight : 0 } };
  }

  async function waitForSelector({ selector, timeoutMs = 10000, state = "visible" }) {
    const deadline = Date.now() + Math.min(Number(timeoutMs) || 10000, 60000);
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      const ok = state === "attached" ? !!el : !!el && isVisible(el);
      if (ok) return { found: true, snapshotLine: describe(el) };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { found: false, selector, state };
  }

  async function waitForUrl({ pattern, timeoutMs = 10000 }) {
    const regex = new RegExp(pattern);
    const deadline = Date.now() + Math.min(Number(timeoutMs) || 10000, 60000);
    while (Date.now() < deadline) {
      if (regex.test(location.href)) return { matched: true, url: location.href, title: document.title };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { matched: false, url: location.href };
  }

  function ping() {
    return {
      protocol: PROTOCOL,
      ready: true,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      installedAt: INSTALLED_AT,
      ageMs: Date.now() - INSTALLED_AT,
    };
  }

  const handlers = { ping, snapshot, click, fill, read, scroll, waitForSelector, waitForUrl };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.source !== "dsh-local-browser-bridge") return false;
    const handler = handlers[message.cmd];
    if (!handler) {
      sendResponse({ ok: false, error: `unknown content command: ${message.cmd}` });
      return false;
    }
    Promise.resolve()
      .then(() => handler(message.args || {}))
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });

  // Keep the MV3 service worker reachable. Service workers are terminated after
  // ~30s without an event/extension-API call; a runtime message from a content
  // script counts as activity and wakes a sleeping worker, so a bridge command
  // enqueued while the worker dozed off is picked up within this interval
  // instead of waiting for the 30s alarm.
  function keepalive() {
    try {
      const pending = chrome.runtime.sendMessage({ type: "dsh-bridge-keepalive", at: Date.now() });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {}
  }
  setTimeout(keepalive, 1500);
  setInterval(keepalive, 20000);
})();
