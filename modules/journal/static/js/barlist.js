/* Horizontal bar lists for Home cards: one row per group with its label, a bar and the value
   written beside it. Plain HTML, so labels never collide with axes, and it reads the same at any
   card width. Bars share one scale with a zero line; losses grow left of it, gains right.
   window.BarList / Node: `scale` is pure; `render` needs window.UI (ui.js) and runs in the browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BarList = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const finite = (v) => typeof v === "number" && Number.isFinite(v);

  /**
   * Where each bar sits on a shared scale, in percent of the track. Rows keep their order and
   * fields and gain {left, width}; `zero` is the zero line's position. Inputs are not changed.
   */
  function scale(rows, valueOf = (r) => r.value) {
    const vals = rows.map(valueOf).map((v) => (finite(v) ? v : 0));
    const min = Math.min(0, ...vals);
    const max = Math.max(0, ...vals);
    const span = max - min || 1;
    const pos = (v) => ((v - min) / span) * 100;
    return {
      zero: pos(0),
      rows: rows.map((r, i) => ({ ...r, left: pos(Math.min(0, vals[i])), width: (Math.abs(vals[i]) / span) * 100 })),
    };
  }

  /**
   * Draw rows [{label, value, text, sub, tone, title}] into `node`. tone: "pos" | "neg" | "info"
   * (defaults to the sign of value). `empty` is shown when there are no rows.
   */
  function render(node, rows, { empty = "Nothing here yet." } = {}) {
    const { el, clear } = globalThis.UI; // ui.js, loaded before this on Home
    if (!rows || !rows.length) return clear(node, el("div", { class: "empty" }, empty));
    const s = scale(rows);
    const list = el("div", { class: "bl" }, s.rows.map((r) => {
      const tone = r.tone || (r.value < 0 ? "neg" : "pos");
      return el("div", { class: "bl-row", title: r.title || "" },
        el("div", { class: "bl-label" }, el("span", { class: "bl-name" }, r.label), r.sub ? el("span", { class: "bl-sub" }, r.sub) : null),
        el("div", { class: "bl-track" }, el("div", { class: `bl-bar ${tone}`, style: { left: `${r.left}%`, width: `${Math.max(r.width, 0.5)}%` } })),
        el("div", { class: `bl-val num ${tone === "info" ? "" : tone}` }, r.text));
    }));
    list.style.setProperty("--zero", `${s.zero}%`); // custom properties need setProperty
    return clear(node, list);
  }

  return { scale, render };
});
