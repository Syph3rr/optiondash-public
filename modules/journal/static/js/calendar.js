/* Daily P&L -> week x weekday grid for the calendar heatmap. Pure. window.Calendar / Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calendar = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const utc = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const mondayOf = (ms) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;

  /**
   * daily: [{key: "YYYY-MM-DD", pnl, trades}]. Returns {weeks: [monday iso], days: WEEKDAYS,
   * z[day][week] (null where nothing closed), text[day][week], dates[day][week]}.
   * Weekend rows are dropped when nothing closed on a weekend.
   */
  function calendarGrid(daily) {
    const rows = (daily || []).filter((r) => r && r.key);
    if (!rows.length) return { weeks: [], days: [], z: [], text: [], dates: [] };
    const byDay = new Map(rows.map((r) => [r.key.slice(0, 10), r]));
    const times = rows.map((r) => utc(r.key));
    const first = mondayOf(Math.min(...times));
    const last = mondayOf(Math.max(...times));
    const weeks = [];
    for (let w = first; w <= last; w += 7 * DAY_MS) weeks.push(w);
    const weekend = rows.some((r) => [0, 6].includes(new Date(utc(r.key)).getUTCDay()));
    const nDays = weekend ? 7 : 5;
    const z = [], text = [], dates = [];
    for (let d = 0; d < nDays; d++) {
      z.push([]); text.push([]); dates.push([]);
      for (const w of weeks) {
        const day = iso(w + d * DAY_MS);
        const r = byDay.get(day);
        z[d].push(r ? r.pnl : null);
        text[d].push(r ? `${r.trades} trade${r.trades === 1 ? "" : "s"}` : "");
        dates[d].push(day);
      }
    }
    return { weeks: weeks.map(iso), days: WEEKDAYS.slice(0, nDays), z, text, dates };
  }

  /** Histogram bin edges (step %) that cover every value and include 0 as an edge. */
  function binEdges(values, step = 10) {
    const vals = (values || []).filter((v) => Number.isFinite(v));
    if (!vals.length) return [];
    const lo = Math.floor(Math.min(0, ...vals) / step) * step;
    const hi = Math.ceil(Math.max(0, ...vals) / step) * step;
    const edges = [];
    for (let e = lo; e <= hi + 1e-9; e += step) edges.push(e);
    if (edges.length < 2) edges.push(lo + step);
    return edges;
  }

  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];

  /** {year, month (1-12)} of the latest close, or of `todayIso` when nothing has closed. */
  function latestMonth(daily, todayIso) {
    const keys = (daily || []).filter((r) => r && r.key).map((r) => r.key.slice(0, 10)).sort();
    const pick = keys.length ? keys[keys.length - 1] : todayIso;
    const [y, m] = pick.split("-").map(Number);
    return { year: y, month: m };
  }

  /** The month before (-1) or after (+1). */
  function shiftMonth({ year, month }, step) {
    const n = year * 12 + (month - 1) + step;
    return { year: Math.floor(n / 12), month: (n % 12) + 1 };
  }

  /**
   * One month as a trading calendar: weeks of Mon-Fri cells (Sat and Sun too when something
   * closed on a weekend that month), each cell {iso, day, inMonth, pnl, trades} (pnl null on
   * days with no close), each week with its own P&L and trade count, plus month totals.
   */
  function monthGrid(daily, year, month) {
    const byDay = new Map((daily || []).filter((r) => r && r.key).map((r) => [r.key.slice(0, 10), r]));
    const first = Date.UTC(year, month - 1, 1);
    const last = Date.UTC(year, month, 0);
    const inMonth = (ms) => ms >= first && ms <= last;
    const weekend = [...byDay.keys()].some((k) => inMonth(utc(k)) && [0, 6].includes(new Date(utc(k)).getUTCDay()));
    const nDays = weekend ? 7 : 5;
    const weeks = [];
    for (let w = mondayOf(first); w <= last; w += 7 * DAY_MS) {
      const cells = [];
      for (let d = 0; d < nDays; d++) {
        const ms = w + d * DAY_MS;
        const r = inMonth(ms) ? byDay.get(iso(ms)) : undefined;
        cells.push({ iso: iso(ms), day: new Date(ms).getUTCDate(), inMonth: inMonth(ms),
          pnl: r ? r.pnl : null, trades: r ? r.trades : 0 });
      }
      // A week of only weekend days of this month (e.g. the 1st is a Sunday) has nothing to show.
      if (!cells.some((c) => c.inMonth)) continue;
      const closed = cells.filter((c) => c.pnl !== null);
      weeks.push({ cells, pnl: round2(closed.reduce((s, c) => s + c.pnl, 0)),
        trades: closed.reduce((s, c) => s + c.trades, 0), active: closed.length > 0 });
    }
    const days = weeks.flatMap((w) => w.cells).filter((c) => c.inMonth && c.pnl !== null);
    return {
      year, month, label: `${MONTH_NAMES[month - 1]} ${year}`,
      weekdays: WEEKDAYS.slice(0, nDays), weeks,
      pnl: round2(days.reduce((s, c) => s + c.pnl, 0)),
      trades: days.reduce((s, c) => s + c.trades, 0),
      greenDays: days.filter((c) => c.pnl > 0).length,
      redDays: days.filter((c) => c.pnl < 0).length,
    };
  }

  const round2 = (x) => Math.round(x * 100) / 100;

  return { calendarGrid, binEdges, latestMonth, shiftMonth, monthGrid, WEEKDAYS };
});
