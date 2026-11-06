/* Pure helpers that turn a journal trade into a request for the gateway's pricing engine
   (POST /api/analyze: American/BAW, Greeks) and read its answer. No DOM: Node tests
   require this file directly.

   Time model: the engine measures time in days from a reference instant. For a trade that
   reference is 09:30 New York on the day it was opened, so every date from entry to the
   last expiry can be priced. Options settle at 16:00 New York on their expiry day, the
   same convention the analyser uses. */
(function (root) {
  "use strict";

  const NY = "America/New_York";
  const DAY_MS = 86400000;
  const OPEN_MIN = 9 * 60 + 30;
  const CLOSE_MIN = 16 * 60;
  const DEFAULT_IV_PCT = 30;
  const DEFAULT_RATE_PCT = 4;
  const N_PRICES = 121;
  const N_DATES = 40;

  function nyOffsetMs(ms) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(ms);
    const f = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const wall = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute);
    return wall - Math.floor(ms / 60000) * 60000;
  }

  /** Instant of a New York day (YYYY-MM-DD) at a minute of that day. */
  function nyToMs(day, minutes) {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
    const wall = Date.UTC(y, m - 1, d, 0, minutes);
    const first = wall - nyOffsetMs(wall);
    return wall - nyOffsetMs(first);
  }

  /** New York calendar day (YYYY-MM-DD) of an instant. */
  function nyDay(ms) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  }

  const expiryMs = (day) => nyToMs(day, CLOSE_MIN);
  const closeOfDayMs = (day) => nyToMs(day, CLOSE_MIN);
  const refMs = (view) => nyToMs(view.opened_at, OPEN_MIN);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** The leg as first opened: 'open' fills only, size-weighted average price. */
  function openingLeg(leg) {
    const opens = (leg.executions || []).filter((e) => e.event === "open");
    const qty = opens.reduce((s, e) => s + e.qty, 0);
    const size = opens.reduce((s, e) => s + Math.abs(e.qty), 0);
    const cost = size ? opens.reduce((s, e) => s + Math.abs(e.qty) * e.price, 0) / size : 0;
    return { qty, cost };
  }

  /**
   * Position legs to price. which: "current" (what is still open, at average cost) or
   * "initial" (the structure as opened). Flat legs are left out.
   */
  function positionLegs(view, which) {
    return (view.legs || []).map((l) => {
      const { qty, cost } = which === "initial" ? openingLeg(l) : { qty: l.net_qty, cost: l.avg_cost };
      return { kind: l.kind, strike: l.strike, expiry: l.expiry, qty, cost, multiplier: l.multiplier };
    }).filter((l) => Math.abs(l.qty) > 1e-9);
  }

  /** Which position the trade page prices first: a closed trade has nothing open, so "As opened". */
  const defaultWhich = (view) => (view && view.status === "closed" ? "initial" : "current");

  const optionLegs = (legs) => legs.filter((l) => l.kind !== "stock" && l.expiry);

  function expiryBounds(legs) {
    const ms = optionLegs(legs).map((l) => expiryMs(l.expiry));
    return ms.length ? { first: Math.min(...ms), last: Math.max(...ms) } : null;
  }

  /** Half-width of the price axis (fraction of spot): strikes plus about two sigma. */
  function autoRange(legs, spot, ivPct, maxDays) {
    const strikes = optionLegs(legs).map((l) => Math.abs(l.strike / spot - 1));
    const sigma = (ivPct / 100) * Math.sqrt(Math.max(maxDays, 1) / 365);
    const want = Math.max(strikes.length ? Math.max(...strikes) * 1.3 + 0.03 : 0, 2 * sigma, 0.05);
    return clamp(Math.round(want * 1000) / 1000, 0.05, 0.9);
  }

  /** Default valuation instant: now for open trades (kept between entry and first expiry), entry for closed ones. */
  function defaultAtMs(view, legs, nowMs) {
    const ref = refMs(view);
    const b = expiryBounds(legs);
    if (view.status !== "open" || !b) return ref;
    return clamp(nowMs, ref, b.first);
  }

  /** Days from the reference to the latest expiry (0 for stock only). */
  function spanDays(view, legs) {
    const b = expiryBounds(legs);
    return b ? Math.max((b.last - refMs(view)) / DAY_MS, 0) : 0;
  }

  /**
   * Body for POST /api/analyze.
   * opts: {spot, ivPct?, ratePct?, atMs?, model?, nPrices?, nDates?}
   */
  function buildRequest(view, legs, opts) {
    const spot = Number(opts.spot);
    if (!(spot > 0)) throw new Error("Enter the underlying price to price this trade.");
    const ivPct = opts.ivPct > 0 ? opts.ivPct : DEFAULT_IV_PCT;
    const ref = refMs(view);
    const days = (ms) => Math.max((ms - ref) / DAY_MS, 0);
    const at = opts.atMs != null ? days(opts.atMs) : 0;
    return {
      spot,
      rate: (opts.ratePct ?? DEFAULT_RATE_PCT) / 100,
      div_yield: 0,
      model: opts.model || "american",
      iv_shift: 0,
      range: autoRange(legs, spot, ivPct, spanDays(view, legs)),
      n_prices: opts.nPrices || N_PRICES,
      n_dates: opts.nDates || N_DATES,
      at_days: [at],
      legs: legs.map((l) => ({
        kind: l.kind,
        long: l.qty > 0,
        qty: Math.abs(l.qty),
        strike: l.kind === "stock" ? 0 : l.strike,
        dte: l.kind === "stock" ? 0 : days(expiryMs(l.expiry)),
        iv: ivPct / 100,
        premium: l.cost,
        multiplier: l.multiplier,
        enabled: true,
      })),
    };
  }

  /** Every calendar day from start to end (YYYY-MM-DD, inclusive). */
  function dayList(startDay, endDay) {
    const out = [];
    const end = Date.parse(String(endDay).slice(0, 10) + "T00:00:00Z");
    for (let t = Date.parse(String(startDay).slice(0, 10) + "T00:00:00Z"); t <= end && out.length < 4000; t += DAY_MS) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  /** Valuation instant for a slider day: entry itself on the first day, 16:00 New York otherwise. */
  function dayToMs(view, days, i) {
    return i <= 0 ? refMs(view) : closeOfDayMs(days[Math.min(i, days.length - 1)]);
  }

  function nearestIndex(values, v) {
    let best = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - v) < Math.abs(values[best] - v)) best = i;
    return best;
  }

  /** Greeks of the whole position at spot on the selected date. */
  function greeksAt(res, tIndex) {
    const j = res.spot_index, g = res.grid;
    return { delta: g.delta[tIndex][j], gamma: g.gamma[tIndex][j], theta: g.theta[tIndex][j], vega: g.vega[tIndex][j] };
  }

  /** New York wall-clock time of an instant, "YYYY-MM-DD HH:MM" (what Plotly date axes and Fmt show). */
  function nyWall(ms) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(ms);
    const f = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}`;
  }

  /** New York wall-clock labels for the engine's time axis (days from the trade's reference). */
  const timesToIso = (view, times) => times.map((t) => nyWall(refMs(view) + t * DAY_MS));

  const api = {
    DAY_MS, DEFAULT_IV_PCT, DEFAULT_RATE_PCT,
    nyToMs, nyDay, expiryMs, closeOfDayMs, refMs, openingLeg, positionLegs, defaultWhich, expiryBounds,
    autoRange, defaultAtMs, spanDays, buildRequest, dayList, dayToMs, nearestIndex, greeksAt, nyWall, timesToIso,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
