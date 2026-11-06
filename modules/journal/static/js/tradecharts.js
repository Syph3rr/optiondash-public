/* Trade page charts, drawn from the gateway's pricing engine (POST /api/analyze) the same
   way the analyser draws them: P&L vs price, P&L heatmap, Greeks × price, Greeks × time.
   Plus the journal's own P&L timeline from fills and marks. Each renderer returns the note
   shown under the chart. */
(function (root) {
  "use strict";
  const { C, MONO } = Charts;

  const vline = (x, color, dash = "dot", width = 1, extra = {}) =>
    ({ type: "line", x0: x, x1: x, yref: "paper", y0: 0, y1: 1, line: { color, width, dash }, ...extra });

  // Closed polygon between the curve and zero, so Plotly can't mis-close the fill.
  const band = (x, y, color) => ({ x: [...x, ...x.slice().reverse()], y: [...y, ...x.map(() => 0)],
    type: "scatter", mode: "lines", line: { width: 0 }, fill: "toself", fillcolor: color, hoverinfo: "skip" });

  const when = (iso) => Fmt.dateTime(iso);

  /** P&L vs price on the selected date (amber) and at the first expiry (blue dashed). */
  function pnl(node, res, ctx) {
    const x = res.prices, y = res.grid.pnl[ctx.tIndex], ye = res.expiry_curve;
    const bes = res.summary.breakevens.filter((b) => b >= x[0] && b <= x[x.length - 1]);
    const atExpiry = Math.abs(res.times[ctx.tIndex] - res.summary.first_expiry) < 1e-6;
    const traces = [
      band(x, y.map((v) => Math.max(v, 0)), C.posFill),
      band(x, y.map((v) => Math.min(v, 0)), C.negFill),
      { x, y: ye, type: "scatter", mode: "lines", line: { color: C.blue, width: 1.5, dash: atExpiry ? "solid" : "dash" },
        hovertemplate: "first expiry  %{y:$,.0f}<extra></extra>" },
      { x, y, type: "scatter", mode: "lines", line: { color: C.accent, width: 2.4 },
        hovertemplate: "price %{x:,.2f}<br>P&L    %{y:$,.0f}<extra></extra>" },
      { x: bes, y: bes.map(() => 0), type: "scatter", mode: "markers",
        marker: { color: C.text, size: 7, symbol: "diamond", line: { color: C.bg, width: 1 } },
        hovertemplate: "breakeven %{x:,.2f}<extra></extra>" },
    ];
    const shapes = [...ctx.strikes.map((k) => vline(k, C.line2, "dot", 1, { layer: "below" })), vline(ctx.spot, C.faint)];
    Charts.render(node, traces, {
      hovermode: "x unified", shapes,
      annotations: [{ x: ctx.spot, y: 1, yref: "paper", text: "spot", showarrow: false, yanchor: "bottom",
        font: { size: 10.5, color: C.faint } }],
      xaxis: { title: { text: `${Fmt.escapeHtml(ctx.underlying)} price`, standoff: 8 } },
      yaxis: { tickprefix: "$", tickformat: ",.0f", zeroline: true, zerolinecolor: C.zero },
      margin: { l: 64, r: 18, t: 16, b: 44 },
    });
    return `Amber: P&L on ${when(ctx.timesIso[ctx.tIndex])} · blue dashed: at the first expiry · dotted: strikes and spot.`;
  }

  /** P&L by price and date. */
  function heat(node, res, ctx) {
    const z = res.prices.map((_, pi) => res.times.map((_, ti) => res.grid.pnl[ti][pi]));
    const lim = Math.max(...z.flat().map(Math.abs)) || 1;
    Charts.render(node, [{
      type: "heatmap", x: ctx.timesIso, y: res.prices, z, zmid: 0, zmin: -lim, zmax: lim,
      colorscale: [[0, C.heat[0]], [0.35, C.heat[1]], [0.5, C.heat[2]], [0.65, C.heat[3]], [1, C.heat[4]]],
      hovertemplate: "%{x|%d %b %Y %H:%M}<br>price %{y:,.2f}<br>P&L %{z:$,.0f}<extra></extra>",
      colorbar: { thickness: 10, outlinewidth: 0, tickprefix: "$", tickformat: ",.0f", tickfont: { family: MONO, size: 10.5 } },
    }], {
      margin: { l: 70, r: 10, t: 16, b: 44 },
      xaxis: { type: "date", gridcolor: "rgba(0,0,0,0)" },
      yaxis: { title: { text: "price", standoff: 6 }, zeroline: false, gridcolor: "rgba(0,0,0,0)" },
      shapes: [
        { type: "line", xref: "paper", x0: 0, x1: 1, y0: ctx.spot, y1: ctx.spot, line: { color: C.muted, width: 1, dash: "dot" } },
        vline(ctx.timesIso[ctx.tIndex], C.accent, "solid", 1.5),
      ],
    });
    return "P&L by price and date · dotted line = spot · amber = selected date.";
  }

  const GREEKS = [["delta", "Delta Δ", ",.1f"], ["gamma", "Gamma Γ", ",.3f"],
    ["theta", "Theta Θ ($/day)", "$,.0f"], ["vega", "Vega ($/vol pt)", "$,.0f"]];

  /** Four small panels, one per Greek. traceFn(key, fmt, xa, ya) → traces; shapesFn(xa, ya) → shapes. */
  function quad(node, traceFn, xTitle, shapesFn, xType) {
    const traces = [], annotations = [], shapes = [];
    const extra = { margin: { l: 58, r: 14, t: 26, b: 40 }, hovermode: "x unified" };
    GREEKS.forEach(([key, title, f], k) => {
      const ax = k ? k + 1 : "";
      const top = k < 2;
      extra["xaxis" + ax] = Charts.axis({ domain: k % 2 ? [0.545, 1] : [0, 0.455], anchor: "y" + ax, type: xType,
        title: top ? undefined : { text: xTitle, standoff: 4, font: { size: 11, color: C.faint } } });
      extra["yaxis" + ax] = Charts.axis({ domain: top ? [0.58, 1] : [0, 0.42], anchor: "x" + ax,
        tickprefix: f.startsWith("$") ? "$" : "", zeroline: true, zerolinecolor: C.zero });
      annotations.push({ text: title, xref: `x${ax} domain`, yref: `y${ax} domain`, x: 0, y: 1.02,
        xanchor: "left", yanchor: "bottom", showarrow: false, font: { size: 11.5, color: C.text } });
      traces.push(...traceFn(key, f, "x" + ax, "y" + ax));
      shapes.push(...shapesFn("x" + ax, "y" + ax));
    });
    Charts.render(node, traces, { ...extra, annotations, shapes });
  }

  /** Greeks across price on the selected date (amber), with entry as a dotted reference. */
  function gprice(node, res, ctx) {
    const x = res.prices, i = ctx.tIndex;
    quad(node, (key, f, xa, ya) => [
      ...(i ? [{ x, y: res.grid[key][0], xaxis: xa, yaxis: ya, type: "scatter", mode: "lines",
        line: { color: C.faint, width: 1.2, dash: "dot" }, hovertemplate: `entry %{y:${f}}<extra></extra>` }] : []),
      { x, y: res.grid[key][i], xaxis: xa, yaxis: ya, type: "scatter", mode: "lines",
        line: { color: C.accent, width: 2 }, hovertemplate: `%{y:${f}}<extra></extra>` },
    ], "price", (xa, ya) => [{ type: "line", xref: xa, yref: `${ya} domain`, x0: ctx.spot, x1: ctx.spot, y0: 0, y1: 1,
      line: { color: C.faint, width: 1, dash: "dot" } }], "linear");
    return `Amber: Greeks of the whole position on ${when(ctx.timesIso[i])}${i ? " · dotted: at entry" : ""}.`;
  }

  /** Greeks at spot across time, with the selected date marked and expiries dotted. */
  function gtime(node, res, ctx) {
    const j = res.spot_index, i = ctx.tIndex;
    const expiriesIso = Engine.timesToIso(ctx.view, res.expiries);
    quad(node, (key, f, xa, ya) => [
      { x: ctx.timesIso, y: res.grid[key].map((r) => r[j]), xaxis: xa, yaxis: ya, type: "scatter", mode: "lines",
        line: { color: C.blue, width: 2 }, hovertemplate: `%{x|%d %b %H:%M}  %{y:${f}}<extra></extra>` },
      { x: [ctx.timesIso[i]], y: [res.grid[key][i][j]], xaxis: xa, yaxis: ya, type: "scatter", mode: "markers",
        marker: { color: C.accent, size: 8 }, hoverinfo: "skip" },
    ], "date", (xa, ya) => expiriesIso.map((e) => ({ type: "line", xref: xa, yref: `${ya} domain`, x0: e, x1: e, y0: 0, y1: 1,
      line: { color: C.faint, width: 1, dash: "dot" } })), "date");
    return `At spot ${Fmt.num(ctx.spot)} (price held fixed) · dotted = leg expiries · amber = selected date.`;
  }

  /** timeline: view.timeline [{at, pnl, kind: fill|mark}] */
  function timeline(node, points) {
    if (!points || !points.length) {
      Charts.empty(node, "No fills yet.");
      return "";
    }
    const fills = points.filter((p) => p.kind === "fill");
    const marks = points.filter((p) => p.kind === "mark");
    const traces = [
      { x: fills.map((p) => p.at), y: fills.map((p) => p.pnl), type: "scatter", mode: "lines+markers",
        line: { shape: "hv", color: C.blue, width: 2 }, marker: { size: 8, color: C.blue, line: { color: C.bg, width: 2 } },
        name: "Cash after fills", hovertemplate: "%{x}<br>cash %{y:$,.2f}<extra></extra>" },
    ];
    if (marks.length) {
      traces.push({ x: marks.map((p) => p.at), y: marks.map((p) => p.pnl), type: "scatter", mode: "lines+markers",
        line: { color: C.accent, width: 2 }, marker: { size: 9, color: C.accent, line: { color: C.bg, width: 2 } },
        name: "Marked P&L", hovertemplate: "%{x}<br>P&L %{y:$,.2f}<extra></extra>" });
    }
    Charts.render(node, traces, {
      hovermode: "closest", showlegend: true,
      xaxis: { type: "date" },
      yaxis: { tickformat: "$,.0f", zeroline: true, zerolinecolor: C.line2 },
      margin: { l: 64, r: 16, t: 30, b: 40 },
    });
    return "Blue: running cash after each fill (credits up, debits down). Amber: cash so far plus the marked value of what is still open.";
  }

  root.TradeCharts = { pnl, heat, gprice, gtime, timeline };
})(window);
