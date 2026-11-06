/* Plotly theme and chart builders, styled to match the app (thin marks, quiet axes). Colours
   come from the current theme (ODPrefs.colors(), set up by /shared/nav.js); the dark values
   below are only a fallback for a page without nav.js. */
(function (root) {
  "use strict";

  const T = root.ODPrefs ? root.ODPrefs.colors() : {};
  const pick = (v, fallback) => v || fallback;
  const C = {
    text: pick(T.text, "#e6e9ef"), muted: pick(T.muted, "#8b95a7"), faint: pick(T.faint, "#5b6577"),
    line: pick(T.line, "#232b38"), line2: pick(T.line2, "#2e3848"),
    panel: pick(T.panel2, "#161c26"), bg: pick(T.bg, "#0b0e13"),
    pos: pick(T.pos, "#2fbf71"), neg: pick(T.neg, "#ef4d5a"), accent: pick(T.accent, "#f2b84b"), blue: pick(T.blue, "#6ea8fe"),
    posFill: pick(T.posBg, "rgba(47,191,113,.16)"), negFill: pick(T.negBg, "rgba(239,77,90,.16)"),
    zero: pick(T.zero, "#3a4558"),
    heat: T.heat && T.heat.every(Boolean) ? T.heat : ["#b8323f", "#5a1f27", "#151a22", "#174a33", "#2fbf71"],
    // Categorical steps of the validated reference palette, fixed order (readable on both themes).
    series: ["#3987e5", "#d95926", "#199e70"],
    mid: pick(T.heatMid, "#383835"),
  };
  const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

  const axis = (extra = {}) => ({
    gridcolor: C.line, zerolinecolor: C.line2, linecolor: C.line, tickcolor: C.line,
    tickfont: { family: MONO, size: 10.5, color: C.faint }, automargin: true, ticks: "", ...extra,
  });

  function layout(extra = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: '"Inter", system-ui, sans-serif', size: 12, color: C.muted },
      margin: { l: 56, r: 16, t: 14, b: 40 },
      xaxis: axis(extra.xaxis), yaxis: axis(extra.yaxis),
      hoverlabel: { bgcolor: C.panel, bordercolor: C.line2, font: { family: MONO, size: 11.5, color: C.text } },
      showlegend: false,
      legend: { orientation: "h", x: 0, y: 1.08, font: { size: 11, color: C.muted } },
      bargap: 0.28, barcornerradius: 4,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "xaxis" && k !== "yaxis")),
    };
  }

  // No floating toolbar: it covered the top of small charts. Hover still shows values.
  const CONFIG = { displaylogo: false, responsive: true, displayModeBar: false };

  function render(node, traces, extra) {
    if (!root.Plotly) {
      UI.clear(node, UI.el("div", { class: "empty" }, "Chart library failed to load."));
      return;
    }
    return Plotly.react(node, traces, layout(extra), CONFIG);
  }

  function empty(node, message) {
    if (root.Plotly) Plotly.purge(node);
    UI.clear(node, UI.el("div", { class: "empty", style: { paddingTop: "80px" } }, message));
  }

  const money = (v) => Fmt.money(v);

  /** Horizontal-or-vertical P&L bars coloured by sign, with direct value labels. */
  function pnlBars(node, rows, { horizontal = false, labelOf = (r) => r.key, emptyMsg = "No closed trades yet." } = {}) {
    if (!rows || !rows.length) return empty(node, emptyMsg);
    // Plotly renders labels as pseudo-HTML: escape user text (tags, underlyings, strategies).
    const cats = rows.map((r) => Fmt.escapeHtml(labelOf(r)));
    const vals = rows.map((r) => r.pnl);
    const colours = vals.map((v) => (v >= 0 ? C.pos : C.neg));
    const hover = rows.map((r, i) => `${cats[i]}<br>${money(r.pnl)} · ${r.trades} trade${r.trades === 1 ? "" : "s"}` +
      (r.win_rate !== undefined ? ` · ${r.win_rate}% win` : ""));
    const trace = {
      type: "bar", marker: { color: colours }, hovertext: hover, hoverinfo: "text",
      text: vals.map(money), textposition: "outside", cliponaxis: false,
      textfont: { family: MONO, size: 10.5, color: C.muted },
      ...(horizontal ? { orientation: "h", y: cats, x: vals } : { x: cats, y: vals }),
    };
    const valueAxis = { tickformat: "$,.0f", zeroline: true, zerolinecolor: C.line2 };
    return render(node, [trace], horizontal
      ? { xaxis: { ...valueAxis, showgrid: true }, yaxis: { autorange: "reversed", type: "category", showgrid: false }, margin: { l: 110, r: 60, t: 10, b: 30 } }
      : { yaxis: valueAxis, xaxis: { type: "category", showgrid: false } });
  }

  root.Charts = { C, MONO, axis, layout, render, empty, pnlBars, CONFIG };
})(window);
