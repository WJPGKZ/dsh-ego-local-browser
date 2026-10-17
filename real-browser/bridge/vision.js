(() => {
  const WHALE_SRC = "data:image/png;base64,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";
  if (!window.__dshVision) {
    const ensure = () => {
      if (document.getElementById("__dsh_vision_style")) return;
      const style = document.createElement("style");
      style.id = "__dsh_vision_style";
      style.textContent = [
        "#__dsh_hand{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;",
        "opacity:0;filter:drop-shadow(0 3px 7px rgba(0,0,0,.35));",
        "transition:transform .26s cubic-bezier(.2,.8,.2,1),opacity .3s ease;",
        "will-change:transform;}",
        "#__dsh_hand img{width:46px;height:auto;display:block;}",
        "#__dsh_hand.__on{opacity:1;}",
        ".__dsh_flash{outline:3px solid #ff2d78 !important;outline-offset:2px !important;",
        "box-shadow:0 0 0 7px rgba(255,45,120,.16) !important;transition:outline .18s,box-shadow .18s;}",
        "#__dsh_hand_label{position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;",
        "font:600 11px/1.4 system-ui,sans-serif;color:#fff;background:#ff2d78;border-radius:10px;",
        "padding:3px 8px;opacity:0;transition:transform .26s,opacity .25s;}",
        "#__dsh_hand_label.__on{opacity:1;}"
      ].join("");
      document.documentElement.appendChild(style);
      const hand = document.createElement("div");
      hand.id = "__dsh_hand";
      const img = document.createElement("img");
      img.alt = "";
      img.src = WHALE_SRC;
      img.draggable = false;
      hand.appendChild(img);
      document.documentElement.appendChild(hand);
      const label = document.createElement("div");
      label.id = "__dsh_hand_label";
      label.textContent = "DSH";
      document.documentElement.appendChild(label);
    };
    const hand = () => document.getElementById("__dsh_hand");
    const label = () => document.getElementById("__dsh_hand_label");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
    };
    let autoHideTimer = null;
    const clearAutoHide = () => {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
        autoHideTimer = null;
      }
    };
    // Safety net: one-shot pointer actions (click/fill/point) may never send an
    // explicit hide(), so the cursor must fade out on its own after the action.
    // startRead refreshes this on every block; hide() cancels it.
    const armAutoHide = () => {
      clearAutoHide();
      autoHideTimer = setTimeout(() => {
        autoHideTimer = null;
        api.hide();
      }, 2500);
    };
    const api = {
      state: { done: false, result: null, error: null },
      ensure,
      pointerTo(el, text) {
        ensure();
        const rect = el.getBoundingClientRect();
        const h = hand();
        const l = label();
        const imgH = 49;
        const imgW = 46;
        const x = Math.max(4, Math.min(window.innerWidth - imgW - 4, rect.left - imgW * 0.18));
        const y = Math.max(4, Math.min(window.innerHeight - imgH - 4, rect.top + Math.min(rect.height / 2, 24) - imgH + 8));
        h.style.transform = `translate(${x}px, ${y}px)`;
        h.classList.add("__on");
        l.textContent = text || "DSH";
        l.style.transform = `translate(${x + imgW - 10}px, ${y + imgH - 6}px)`;
        l.classList.add("__on");
        armAutoHide();
      },
      hide() {
        clearAutoHide();
        const h = hand();
        const l = label();
        if (h) h.classList.remove("__on");
        if (l) l.classList.remove("__on");
      },
      flash(el) {
        el.classList.add("__dsh_flash");
        setTimeout(() => el.classList.remove("__dsh_flash"), 520);
      },
      find(target) {
        if (target && target.ref) return document.querySelector(`[data-dsh-ref="${target.ref}"]`);
        if (target && target.selector) return document.querySelector(target.selector);
        if (target && target.text) {
          const wanted = norm(target.text);
          const candidates = Array.from(document.querySelectorAll("a,button,[role=button],input[type=submit],li,span,div,h1,h2,h3,h4"));
          return candidates.find((el) => norm(el.textContent) === wanted) || candidates.find((el) => norm(el.textContent).indexOf(wanted) === 0);
        }
        return null;
      },
      collectBlocks(limit) {
        const tags = new Set(["H1", "H2", "H3", "H4", "H5", "P", "LI", "TD", "TH", "PRE", "BLOCKQUOTE", "FIGCAPTION", "SUMMARY", "LABEL"]);
        const blocks = [];
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, null);
        let node = walker.currentNode;
        while ((node = walker.nextNode()) && blocks.length < limit) {
          if (!tags.has(node.tagName)) continue;
          if (!visible(node)) continue;
          const text = norm(node.innerText || node.textContent);
          if (text.length < 2) continue;
          if (blocks.some((b) => b.el.contains(node))) continue;
          blocks.push({ el: node, text: text.slice(0, 400) });
        }
        return blocks;
      },
      async startRead(options = {}) {
        ensure();
        api.state = { done: false, result: null, error: null };
        try {
          const delayMs = Math.min(Number(options.delayMs) || 180, 800);
          const blocks = api.collectBlocks(Math.min(Number(options.maxBlocks) || 90, 200));
          const lines = [];
          for (let i = 0; i < blocks.length; i += 1) {
            const block = blocks[i];
            try {
              block.el.scrollIntoView({ block: "center", behavior: "smooth" });
            } catch {}
            await sleep(190);
            api.pointerTo(block.el, "阅读中…");
            api.flash(block.el);
            await sleep(delayMs);
            lines.push(block.text);
          }
          api.state = {
            done: true,
            error: null,
            result: { title: document.title, url: location.href, blocks: blocks.length, text: norm(document.title) + " — " + location.href + "\n\n" + lines.join("\n") },
          };
        } catch (error) {
          api.state = { done: true, result: null, error: String((error && error.message) || error) };
        }
        api.hide();
      },
      async point(target, ms) {
        const el = api.find(target);
        if (!el) return { ok: false, error: "target not found" };
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        await sleep(220);
        api.pointerTo(el, "DSH");
        api.flash(el);
        await sleep(Number(ms) || 300);
        return { ok: true, text: norm(el.textContent || el.value || "").slice(0, 120) };
      },
    };
    window.__dshVision = api;
  }
  window.__dshVision.ensure();
  return "vision-installed";
})()
