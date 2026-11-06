/* The two panels on the Trades page: New trade (form.js) and IBKR fill import (ibkr.js; the only
 * place the import lives now, /journal/ibkr redirects here). This only opens and closes them. Each opens from its
 * button, or on load when the URL asks: ?new=1 or ?from=analyser (the analyser's "Log as
 * trade" hand-off) for New trade, ?import=1 for the import. /journal/new redirects here.
 * Pure helpers are exported for Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.Panels = api;
    api.mount(root);
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FROM_ANALYSER = ["analyser", "analyzer"]; // the old spelling still works

  const PANELS = [
    { id: "new-trade", open: "open-new", close: "cancel-new", param: "new", focus: "underlying",
      // Closing also drops ?from=, so a reload neither re-opens it nor re-reads a prefill.
      drop: ["new", "from"], alsoOpen: (q) => FROM_ANALYSER.includes(q.get("from")), redraw: "preview" },
    { id: "ibkr-import", open: "open-import", close: "close-import", param: "import", drop: ["import"] },
  ];

  /** Whether a URL query asks for this panel to start open. */
  function wantsOpen(panel, search) {
    const q = new URLSearchParams(search || "");
    return q.has(panel.param) || Boolean(panel.alsoOpen && panel.alsoOpen(q));
  }

  /** The query string with this panel marked open or closed; other parameters are kept. */
  function panelSearch(panel, search, open) {
    const q = new URLSearchParams(search || "");
    if (open) q.set(panel.param, "1");
    else panel.drop.forEach((k) => q.delete(k));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  function wire(win, doc, panel) {
    const box = doc.getElementById(panel.id);
    const openBtn = doc.getElementById(panel.open);
    const closeBtn = doc.getElementById(panel.close);
    if (!box || !openBtn) return;

    const setUrl = (open) => {
      const { pathname, search, hash } = win.location;
      win.history.replaceState(null, "", `${pathname}${panelSearch(panel, search, open)}${hash}`);
    };
    const show = (open) => {
      box.classList.toggle("hidden", !open);
      openBtn.setAttribute("aria-expanded", String(open));
      openBtn.classList.toggle("hidden", open);
      setUrl(open);
      if (!open) return;
      // A chart drawn while hidden has the wrong width.
      const chart = panel.redraw && doc.getElementById(panel.redraw);
      if (win.Plotly && chart && chart.classList.contains("js-plotly-plot")) win.Plotly.Plots.resize(chart);
      box.scrollIntoView({ block: "start" });
      const first = panel.focus && doc.getElementById(panel.focus);
      if (first) first.focus();
    };

    openBtn.addEventListener("click", (e) => { e.preventDefault(); show(true); });
    if (closeBtn) closeBtn.addEventListener("click", () => show(false));
    if (wantsOpen(panel, win.location.search)) show(true);
  }

  function mount(win) {
    const doc = win.document;
    const go = () => PANELS.forEach((p) => wire(win, doc, p));
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go);
    else go();
  }

  return { PANELS, wantsOpen, panelSearch, mount };
});
