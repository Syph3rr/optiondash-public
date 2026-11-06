/* Journal analytics, drawn as Home cards (the old Dashboard page now lives on Home).
 * Stats come from one GET /api/journal/stats, shared by every card in a mount round; the Open
 * trades card reads GET /api/journal/trades. Each renderer draws into the node it is given, so
 * cards never depend on page ids.
 *
 * Home shows a focused set by default (performance, equity, open risk, open trades, P&L by
 * strategy, the P&L calendar). Every other card is `optional`: added from Edit layout > Add card.
 * Category breakdowns are HTML bar lists (BarList): labels and values never collide with axes.
 * window.JournalDashboard = { stats, cards }. Needs Fmt, Calendar, BarList, OpenTrades, UI, Api, Charts. */
(function (root) {
  "use strict";
  const { el, clear, stat } = UI;
  const { C } = Charts;

  // Journal URLs follow Home's account filter (ODWidgets.withAccounts); without it, all accounts.
  const journalUrl = (path) => (root.ODWidgets && root.ODWidgets.withAccounts ? root.ODWidgets.withAccounts(path) : path);

  // One stats request per Home mount (or Refresh): the cards all mount within a moment. Shared
  // only for the same URL, so a new account selection never gets the previous selection's stats.
  const SHARE_MS = 3000;
  let cache = null;
  let cachedAt = 0;
  let cachedUrl = "";
  function stats() {
    const url = journalUrl("/api/journal/stats");
    if (cache && url === cachedUrl && Date.now() - cachedAt < SHARE_MS) return cache;
    cachedAt = Date.now();
    cachedUrl = url;
    const request = Api.get(url);
    cache = request;
    request.catch(() => { if (cache === request) cache = null; });
    return request;
  }

  const todayIso = () => Fmt.todayIso();
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const whole = (v) => Fmt.money(v, { digits: 0 });

  // ------------------------------------------------------------ performance

  /** Twelve tiles, most important first, so any grid (6x2, 4x3, 3x4, 2x6) reads left to right. */
  function headline(node, h) {
    clear(node,
      stat("Net P&L", Fmt.money(h.total_pnl), Fmt.signClass(h.total_pnl), "realised, after fees"),
      stat("Win rate", Fmt.pct(h.win_rate), "", h.scratches > 0 ? `${plural(h.scratches, "scratch")}` : `${h.trades} closed`),
      stat("Profit factor", h.profit_factor === null ? "—" : Fmt.num(h.profit_factor), "", "gross win ÷ gross loss"),
      stat("Expectancy", Fmt.money(h.expectancy), Fmt.signClass(h.expectancy), "per trade"),
      stat("Avg win", Fmt.money(h.avg_win), "pos"),
      stat("Avg loss", Fmt.money(h.avg_loss), "neg"),
      stat("Closed trades", String(h.trades)),
      stat("Open trades", String(h.open_trades)),
      stat("Largest win", h.largest_win > 0 ? Fmt.money(h.largest_win) : "—", "pos"),
      stat("Largest loss", h.largest_loss < 0 ? Fmt.money(h.largest_loss) : "—", "neg"),
      stat("Avg days held", h.avg_days_held === null ? "—" : Fmt.num(h.avg_days_held, 1)),
      stat("Commissions", Fmt.plainMoney(h.commissions)));
  }

  // ------------------------------------------------------------ equity and drawdown

  const alpha = (hex, a) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  /** One chart: cumulative P&L on top, drawdown below, on one shared date axis. */
  function equity(node, rows) {
    if (!rows.length) return Charts.empty(node, "No closed trades yet.");
    // Start from $0 the day before the first close, so even one trade draws a line.
    const start = new Date(`${rows[0].date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    const all = [{ date: start.toISOString().slice(0, 10), equity: 0, drawdown: 0, pnl: 0, start: true }, ...rows];
    const x = all.map((r) => r.date);
    const info = all.map((r) => (r.start ? "start" : `#${r.id} ${Fmt.escapeHtml(r.underlying)} ${whole(r.pnl)}`));
    // Equity in the neutral accent; red is kept for drawdown so the two panels never look alike.
    const lineColour = C.blue;
    Charts.render(node, [
      { x, y: all.map((r) => r.equity), customdata: info, type: "scatter", mode: "lines+markers", name: "Equity",
        line: { color: lineColour, width: 2, shape: "hv" }, fill: "tozeroy", fillcolor: alpha(lineColour, 0.08),
        marker: { size: all.map((r) => (r.start ? 0 : 6)), color: all.map((r) => (r.pnl >= 0 ? C.pos : C.neg)), line: { width: 0 } },
        hovertemplate: "%{customdata}<br>equity %{y:$,.0f}<extra></extra>" },
      { x, y: all.map((r) => r.drawdown), yaxis: "y2", type: "scatter", mode: "lines", name: "Drawdown",
        line: { color: C.neg, width: 1.5, shape: "hv" }, fill: "tozeroy", fillcolor: C.negFill,
        hovertemplate: "drawdown %{y:$,.0f}<extra></extra>" },
    ], {
      hovermode: "x unified",
      margin: { l: 58, r: 14, t: 8, b: 28 },
      xaxis: { type: "date", tickformat: "%-d %b", anchor: "y2", showgrid: false, nticks: 6 },
      yaxis: { domain: [0.34, 1], tickformat: "$,.0f", nticks: 5, zeroline: true },
      yaxis2: Charts.axis({ domain: [0, 0.24], tickformat: "$,.0f", nticks: 3, zeroline: false,
        range: [Math.min(-1, 1.15 * Math.min(...all.map((r) => r.drawdown))), 0] }),
      annotations: [{ text: "DRAWDOWN", xref: "paper", yref: "paper", x: 0, y: 0.25, xanchor: "left", yanchor: "bottom",
        showarrow: false, font: { size: 9.5, color: C.faint } }],
    });
  }

  // ------------------------------------------------------------ month calendar

  /** A trading calendar for one month (Mon-Fri + week totals), with arrows to move between months. */
  function calendar(box, daily) {
    let shown = Calendar.latestMonth(daily, todayIso());
    const today = todayIso();
    const tone = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
    function draw() {
      const g = Calendar.monthGrid(daily, shown.year, shown.month);
      const nav = (step, label) => el("button", { class: "cal-nav", type: "button", "aria-label": label,
        onclick: () => { shown = Calendar.shiftMonth(shown, step); draw(); } }, step < 0 ? "‹" : "›");
      const head = el("div", { class: "cal-head" },
        nav(-1, "Previous month"), el("strong", { class: "cal-month" }, g.label), nav(1, "Next month"),
        el("span", { class: "grow" }),
        el("span", { class: "cal-sum" }, el("span", { class: `num ${tone(g.pnl)}` }, g.trades ? whole(g.pnl) : "—"),
          el("span", { class: "s" }, g.trades ? ` · ${plural(g.trades, "trade")} · ${g.greenDays} green / ${g.redDays} red days` : " · no closes")));
      const grid = el("div", { class: "cal-grid", style: { gridTemplateColumns: `repeat(${g.weekdays.length}, minmax(0, 1fr)) minmax(0, 0.9fr)` } },
        g.weekdays.map((d) => el("div", { class: "cal-dow" }, d)), el("div", { class: "cal-dow" }, "Week"),
        g.weeks.map((w) => [
          ...w.cells.map((c) => el("div", { class: `cal-day ${c.inMonth ? "" : "out"} ${c.pnl === null ? "" : tone(c.pnl)} ${c.iso === today ? "today" : ""}`,
            title: c.pnl === null ? Fmt.date(c.iso) : `${Fmt.date(c.iso)} · ${Fmt.money(c.pnl)} · ${plural(c.trades, "trade")}` },
            el("span", { class: "d" }, String(c.day)),
            c.pnl === null ? null : el("span", { class: "v num" }, whole(c.pnl)),
            c.pnl === null ? null : el("span", { class: "t" }, plural(c.trades, "trade")))),
          el("div", { class: `cal-week ${w.active ? tone(w.pnl) : ""}` },
            w.active ? el("span", { class: "v num" }, whole(w.pnl)) : el("span", { class: "t" }, "—"),
            w.active ? el("span", { class: "t" }, plural(w.trades, "trade")) : null),
        ]));
      clear(box, head, grid);
    }
    draw();
  }

  // ------------------------------------------------------------ bar lists

  /** P&L by group as a bar list: label, a bar on a shared zero line, and the value. */
  const pnlRows = (rows, labelOf) => (rows || []).map((r) => ({
    label: labelOf(r), value: r.pnl, text: whole(r.pnl),
    sub: `${plural(r.trades, "trade")}${r.win_rate !== undefined ? ` · ${Fmt.pct(r.win_rate, 0)} win` : ""}`,
  }));

  function openRisk(box, rows) {
    if (!rows.length) return clear(box, el("div", { class: "empty" }, "No open trades."));
    const today = todayIso();
    const total = rows.reduce((s, r) => s + r.risk, 0);
    const unlimited = rows.reduce((s, r) => s + r.unlimited, 0);
    const days = (iso) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
    const list = el("div");
    BarList.render(list, rows.map((r) => ({
      label: r.expiry === "no expiry" ? "No expiry" : Fmt.date(r.expiry, false),
      sub: r.expiry === "no expiry" ? "stock" : `${days(r.expiry)}d`,
      value: r.risk, tone: "info",
      text: `${Fmt.plainMoney(r.risk, 0)}${r.unlimited ? " + ∞" : ""}`,
      title: r.unlimited ? `${plural(r.unlimited, "trade")} on this expiry with no bound on loss` : "",
    })));
    clear(box,
      el("div", { class: "jx-total" }, el("span", { class: "k" }, "Max loss, all open trades"),
        el("span", { class: "v num" }, Fmt.plainMoney(total, 0)),
        unlimited ? el("span", { class: "s neg" }, ` + ${plural(unlimited, "trade")} unlimited`) : null),
      list);
  }

  // ------------------------------------------------------------ open trades

  const OPEN_ROWS = 8;

  function openTrades(box, trades) {
    const rows = OpenTrades.rows(trades, todayIso());
    if (!rows.length) return clear(box, el("div", { class: "empty" }, "No open trades."));
    const go = (id) => `/journal/trade?id=${encodeURIComponent(id)}`;
    const head = el("thead", {}, el("tr", {}, el("th", {}, "Trade"), el("th", {}, "Next expiry"),
      el("th", { class: "r" }, "Max loss"), el("th", { class: "r" }, "Opened for"), el("th", { class: "r" }, "Held")));
    const body = el("tbody", {}, rows.slice(0, OPEN_ROWS).map((r) => el("tr", {},
      el("td", {}, el("a", { class: "ot-sym", href: go(r.id) }, r.underlying), el("span", { class: "ot-sub" }, Fmt.strategyLabel(r.strategy))),
      el("td", {}, r.expiry ? Fmt.date(r.expiry, false) : "—",
        r.dte === null ? null : el("span", { class: `ot-sub ${r.dte <= 7 ? "warn" : ""}` }, r.dte < 0 ? "expired" : `${r.dte}d`)),
      el("td", { class: `r num ${r.unlimited ? "neg" : ""}` }, r.unlimited ? "Unlimited" : Fmt.plainMoney(r.risk, 0)),
      el("td", { class: "r num" }, r.cash === null ? "—" : `${Fmt.plainMoney(Math.abs(r.cash), 0)} ${r.cash >= 0 ? "cr" : "db"}`),
      el("td", { class: "r num" }, r.daysHeld === null ? "—" : `${r.daysHeld}d`))));
    const more = rows.length > OPEN_ROWS
      ? el("a", { class: "ot-more", href: "/journal/" }, `All ${rows.length} open trades →`) : null;
    clear(box, el("div", { class: "table-wrap" }, el("table", { class: "t ot" }, head, body)), more);
  }

  // ------------------------------------------------------------ return on risk (histogram)

  function ror(node, rows) {
    const vals = rows.map((r) => r.ror).filter(Number.isFinite);
    if (!vals.length) return Charts.empty(node, "No closed trades with a known max risk yet.");
    const edges = Calendar.binEdges(vals, 10);
    const counts = edges.slice(0, -1).map((lo, i) => vals.filter((v) => v >= lo && (v < edges[i + 1] || (i === edges.length - 2 && v === edges[i + 1]))).length);
    const centres = edges.slice(0, -1).map((lo) => lo + 5);
    Charts.render(node, [{
      type: "bar", x: centres, y: counts, width: 9.2,
      marker: { color: centres.map((c) => (c >= 0 ? C.pos : C.neg)) },
      customdata: edges.slice(0, -1).map((lo, i) => `${lo}% to ${edges[i + 1]}%`),
      hovertemplate: "%{customdata}<br>%{y} trade(s)<extra></extra>",
    }], { margin: { l: 36, r: 12, t: 8, b: 28 }, xaxis: { ticksuffix: "%", zeroline: true, zerolinecolor: C.line2, nticks: 8 },
      yaxis: { dtick: 1, rangemode: "tozero" } });
  }

  // ------------------------------------------------------------ breakdown table

  const TABLES = [
    ["by_strategy", "By strategy"], ["by_underlying", "By underlying"], ["by_month", "By month"],
    ["by_dte", "By DTE"], ["by_weekday_open", "By weekday opened"], ["by_weekday_close", "By weekday closed"],
    ["by_hold", "By days held"], ["by_confidence", "By confidence"], ["by_mistake", "By mistake"],
    ["by_emotion", "By emotion"], ["by_tag", "By tag"],
  ];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthLabel = (key) => {
    const [y, m] = String(key).split("-").map(Number);
    return m ? `${MONTHS[m - 1]} ${y}` : key;
  };

  function label(key, value) {
    if (key === "by_strategy") return Fmt.strategyLabel(value);
    if (key === "by_confidence") return value === "unrated" ? "Unrated" : `${Fmt.stars(Number(value))} (${value})`;
    if (key === "by_dte") return value === "n/a" ? "No expiry" : `${value} DTE`;
    if (key === "by_month") return monthLabel(value);
    return value;
  }

  function breakdownTable(table, data, key) {
    const rows = data[key] || [];
    const head = el("thead", {}, el("tr", {}, el("th", {}, "Group"), el("th", { class: "r" }, "Trades"),
      el("th", { class: "r" }, "Win rate"), el("th", { class: "r" }, "P&L"), el("th", { class: "r" }, "Avg / trade")));
    const body = el("tbody", {}, rows.length ? rows.map((r) => el("tr", {},
      el("td", {}, label(key, r.key)), el("td", { class: "r num" }, String(r.trades)),
      el("td", { class: "r num" }, Fmt.pct(r.win_rate)), el("td", { class: `r num ${Fmt.signClass(r.pnl)}` }, Fmt.money(r.pnl)),
      el("td", { class: `r num ${Fmt.signClass(r.pnl)}` }, Fmt.money(r.trades ? r.pnl / r.trades : null))))
      : el("tr", {}, el("td", { colspan: 5, class: "empty" }, "Nothing here yet.")));
    clear(table, head, body);
  }

  function breakdown(box, data) {
    const pick = el("select", { class: "inp", "aria-label": "Group the table by" },
      TABLES.map(([value, text]) => el("option", { value }, text)));
    const table = el("table", { class: "t" });
    clear(box, el("div", { class: "jx-pick" }, pick), el("div", { class: "table-wrap" }, table));
    pick.addEventListener("change", () => breakdownTable(table, data, pick.value));
    breakdownTable(table, data, pick.value);
  }

  // ------------------------------------------------------------ cards

  // A Plotly chart card: one chart div in the card body, drawn by `draw(node, stats)`.
  const chart = (draw, size = "sm") => async (box) => {
    const node = el("div", { class: `chart ${size}` });
    box.classList.add("jx-flush");
    clear(box, node);
    draw(node, await stats());
  };
  // An HTML card body drawn by `draw(box, stats)`.
  const html = (draw) => async (box) => { draw(box, await stats()); };
  // Bar lists and the open-risk list bring their own padding, so their card body is flush.
  const flush = (draw) => async (box) => { box.classList.add("jx-flush"); draw(box, await stats()); };
  const bars = (key, labelOf = (r) => label(key, r.key), empty = "No closed trades yet.") =>
    flush((box, s) => BarList.render(box, pnlRows(s[key], labelOf), { empty }));

  /** Home cards. Without `optional` a card is on Home by default; the rest are add-ons. */
  const cards = [
    { id: "journal-headline", title: "Performance", size: 3, order: 20,
      mount: async (box) => { const node = el("div", { class: "stats" }); box.classList.add("jx-flush", "jx-kpis"); clear(box, node); headline(node, (await stats()).headline); } },
    { id: "journal-equity", title: "Equity curve", size: 2, order: 30, link: "/journal/",
      mount: chart((n, s) => equity(n, s.equity), "eq") },
    { id: "journal-risk", title: "Open risk by expiry", size: 1, order: 31, mount: flush((box, s) => openRisk(box, s.open_risk)) },
    { id: "journal-open", title: "Open trades", size: 2, order: 40, link: "/journal/",
      mount: async (box) => { box.classList.add("jx-flush"); openTrades(box, await Api.get(journalUrl("/api/journal/trades"))); } },
    { id: "journal-strategy", title: "P&L by strategy", size: 1, order: 41, mount: bars("by_strategy") },
    { id: "journal-calendar", title: "P&L calendar", size: 2, order: 50, mount: html((box, s) => calendar(box, s.daily)) },

    // Add-ons: off until added from Edit layout > Add card.
    { id: "journal-month", title: "Monthly P&L", size: 1, order: 60, optional: true, mount: bars("by_month") },
    { id: "journal-underlying", title: "P&L by underlying", size: 1, order: 61, optional: true, mount: bars("by_underlying") },
    { id: "journal-dte", title: "P&L by DTE at entry", size: 1, order: 62, optional: true, mount: bars("by_dte") },
    { id: "journal-hold", title: "P&L by days held", size: 1, order: 63, optional: true, mount: bars("by_hold") },
    { id: "journal-weekday-open", title: "P&L by weekday opened", size: 1, order: 64, optional: true, mount: bars("by_weekday_open") },
    { id: "journal-weekday-close", title: "P&L by weekday closed", size: 1, order: 65, optional: true, mount: bars("by_weekday_close") },
    { id: "journal-confidence", title: "P&L by confidence", size: 1, order: 66, optional: true,
      mount: bars("by_confidence", (r) => (r.key === "unrated" ? "Unrated" : `${r.key}★`)) },
    { id: "journal-mistake", title: "Cost of mistakes", size: 1, order: 67, optional: true,
      mount: bars("by_mistake", (r) => r.key, "No mistakes tagged on closed trades yet.") },
    { id: "journal-emotion", title: "P&L by emotion", size: 1, order: 68, optional: true,
      mount: bars("by_emotion", (r) => r.key, "No emotion tags on closed trades yet.") },
    { id: "journal-ror", title: "Return on risk", size: 1, order: 69, optional: true, mount: chart((n, s) => ror(n, s.return_on_risk)) },
    { id: "journal-breakdown", title: "Breakdown table", size: 2, order: 70, optional: true,
      mount: async (box) => { box.classList.add("jx-flush"); breakdown(box, await stats()); } },
  ];

  root.JournalDashboard = { stats, cards };
})(window);
