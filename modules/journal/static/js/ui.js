/* Shared DOM helpers: element builder, header, toasts, modals, chips and star inputs.
 * User text only ever goes in via textContent (the `el` builder), never innerHTML. */
(function (root) {
  "use strict";

  /** el("div", {class: "x", onclick: fn, dataset: {...}}, child, "text", [more]) */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k in node && typeof v !== "string") node[k] = v;
      else if (k === "value") node.value = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function clear(node, ...children) {
    node.replaceChildren();
    return append(node, children);
  }

  const $ = (sel, scope = document) => scope.querySelector(sel);

  // ---------- page setup ---------------------------------------------------------------
  // The platform nav bar comes from /shared/nav.js; the journal only adds its toast area.
  function header() {
    if (!$("#toasts")) document.body.append(el("div", { id: "toasts", role: "status", "aria-live": "polite" }));
  }

  // ---------- toasts -------------------------------------------------------------------
  function toast(message, kind = "info", ms = kind === "err" ? 9000 : 3500) {
    const box = $("#toasts") || document.body.appendChild(el("div", { id: "toasts" }));
    const node = el("div", { class: `toast ${kind}` },
      el("div", { class: "msg" }, message),
      el("button", { type: "button", "aria-label": "Dismiss", onclick: () => node.remove() }, "✕"));
    box.append(node);
    if (ms) setTimeout(() => node.remove(), ms);
    return node;
  }

  // ---------- modals -------------------------------------------------------------------
  /** actions: [{label, kind: "primary"|"danger"|"", onClick: async () => bool (true closes)}] */
  function modal({ title, body, actions = [], narrow = false, onClose }) {
    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    // While one action runs, every action button is disabled and further clicks are ignored,
    // so two actions (e.g. "Save & add another" and "Save fills") can't both post.
    let busy = false;
    const setBusy = (on) => { busy = on; buttons.forEach((x) => { x.disabled = on; }); };
    const buttons = actions.map((a) => {
      const b = el("button", { type: "button", class: `btn ${a.kind || ""}` }, a.label);
      b.addEventListener("click", async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = a.onClick ? await a.onClick() : true;
          if (result !== false) close();
        } catch (err) {
          // Api errors were already toasted by the fetch wrapper; don't show them twice.
          const fromApi = root.Api && err instanceof root.Api.ApiError;
          if (!fromApi) toast(err.message || String(err), "err");
        } finally {
          setBusy(false);
        }
      });
      return b;
    });
    const overlay = el("div", { class: "overlay", onmousedown: (e) => { if (e.target === overlay) close(); } },
      el("div", { class: `modal ${narrow ? "narrow" : ""}`, role: "dialog", "aria-modal": "true" },
        el("div", { class: "card-h" }, el("h2", {}, title), el("span", { class: "grow" }),
          el("button", { type: "button", class: "iconbtn", "aria-label": "Close", onclick: close }, "✕")),
        el("div", { class: "card-b" }, body),
        actions.length ? el("div", { class: "modal-f" },
          el("button", { type: "button", class: "btn", onclick: close }, "Cancel"), buttons) : null));
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    const first = overlay.querySelector("input, select, textarea");
    if (first) first.focus();
    return close;
  }

  /** In-page replacement for window.confirm. Resolves true/false. */
  function confirmModal(message, { title = "Are you sure?", confirmLabel = "Delete", kind = "danger" } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      modal({
        title, narrow: true,
        body: el("p", { style: { margin: 0 } }, message),
        actions: [{ label: confirmLabel, kind, onClick: () => { answered = true; resolve(true); return true; } }],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  // ---------- chips input --------------------------------------------------------------
  /** Free-text chips with suggestions. Values are lowercased, de-duplicated, <= 60 chars. */
  function chipsInput({ values = [], suggestions = [], placeholder = "type + Enter", kind = "" }) {
    let current = [...new Set(values.map(norm).filter(Boolean))];
    const input = el("input", { type: "text", placeholder, maxlength: 60 });
    const box = el("div", { class: "chip-input", onclick: () => input.focus() });
    const sugg = el("div", { class: "suggest" });
    const listeners = [];

    function norm(v) { return String(v || "").trim().toLowerCase().slice(0, 60); }
    function changed() { render(); listeners.forEach((fn) => fn(current)); }
    function add(v) {
      const n = norm(v);
      if (n && !current.includes(n)) { current = [...current, n]; changed(); }
    }
    function remove(v) { current = current.filter((x) => x !== v); changed(); }
    function render() {
      clear(box, current.map((v) => el("span", { class: `chip ${kind}` }, v,
        el("button", { type: "button", "aria-label": `Remove ${v}`, onclick: (e) => { e.stopPropagation(); remove(v); } }, "×"))), input);
      const left = [...new Set(suggestions.map(norm))].filter((s) => s && !current.includes(s));
      clear(sugg, left.map((s) => el("button", { type: "button", onclick: () => add(s) }, `+ ${s}`)));
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input.value); input.value = ""; }
      else if (e.key === "Backspace" && !input.value && current.length) remove(current[current.length - 1]);
    });
    input.addEventListener("blur", () => { if (input.value.trim()) { add(input.value); input.value = ""; } });
    render();
    return {
      el: el("div", {}, box, sugg),
      values: () => [...current],
      onChange: (fn) => listeners.push(fn),
    };
  }

  // ---------- star rating --------------------------------------------------------------
  function starInput(value = null) {
    let current = value;
    const listeners = [];
    const wrap = el("span", { class: "star-input", role: "radiogroup", "aria-label": "Confidence" });
    function render() {
      clear(wrap, [1, 2, 3, 4, 5].map((n) => el("button", {
        type: "button", class: current && n <= current ? "on" : "", title: `${n} / 5`, "aria-label": `${n} of 5`,
        onclick: () => { current = current === n ? null : n; render(); listeners.forEach((fn) => fn(current)); },
      }, "★")));
    }
    render();
    return { el: wrap, value: () => current, onChange: (fn) => listeners.push(fn) };
  }

  function stat(k, v, cls = "", sub = "") {
    return el("div", { class: "stat" }, el("div", { class: "k" }, k),
      el("div", { class: `v ${cls}` }, v), sub ? el("div", { class: "s" }, sub) : null);
  }

  function field(label, control, extraClass = "") {
    return el("div", { class: `field ${extraClass}` }, el("label", {}, label), control);
  }

  /** Parse a number input: "" -> null, otherwise a finite number or NaN. */
  function numVal(input) {
    const raw = String(input.value ?? "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  root.UI = { el, append, clear, $, header, toast, modal, confirmModal, chipsInput, starInput, stat, field, numVal };
})(window);
