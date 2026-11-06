// Links the analyser and the trade journal, both ways. Pure helpers: no DOM, no fetch.
// Loaded in the browser as window.ODJournal and in Node tests through module.exports.
//
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("journallink.js", JS, "../modules/analyser/web/journallink.js"),
(function (root) {
  'use strict';

  const EPS = 1e-9;
  const PM_SETTLE_MINUTES = 960;              // 16:00 New York: US equity options settle at the close
  const DEFAULT_IV = 18;                      // the analyser presets' default, in percent
  const INDEX_SYMBOLS = new Set(['SPX', 'XSP', 'NDX', 'RUT', 'VIX', 'DJX', 'OEX']);
  const PREFILL_KEY = 'journal.prefill';

  const num = (x) => typeof x === 'number' && isFinite(x);
  const compact = (iso) => iso.replace(/-/g, '');            // 2026-12-18 -> 20261218
  const isoOf = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

  /** The leg as first opened: 'open' executions only, summed qty and qty-weighted price. */
  function openingOf(leg) {
    const opens = (leg.executions || []).filter((e) => e.event === 'open');
    const qty = opens.reduce((a, e) => a + e.qty, 0);
    const size = opens.reduce((a, e) => a + Math.abs(e.qty), 0);
    const price = size ? opens.reduce((a, e) => a + Math.abs(e.qty) * e.price, 0) / size : 0;
    return { qty, price };
  }

  /**
   * The position to show for a journal trade view: the legs still open, or for a closed trade
   * the position as first opened.
   * @returns {{source: 'current'|'initial', legs: {kind, qty, strike, expiry, price, multiplier}[]}}
   */
  function positionOf(trade) {
    const legs = trade.legs || [];
    const open = legs.filter((l) => Math.abs(l.net_qty || 0) > EPS);
    if (open.length) {
      return { source: 'current', legs: open.map((l) => ({ kind: l.kind, qty: l.net_qty, strike: l.strike,
        expiry: l.expiry, price: l.avg_cost, multiplier: l.multiplier })) };
    }
    const initial = legs.map((l) => ({ l, o: openingOf(l) })).filter(({ o }) => Math.abs(o.qty) > EPS)
      .map(({ l, o }) => ({ kind: l.kind, qty: o.qty, strike: l.strike, expiry: l.expiry,
        price: o.price, multiplier: l.multiplier }));
    return { source: 'initial', legs: initial };
  }

  const modelFor = (symbol) => (INDEX_SYMBOLS.has(String(symbol).toUpperCase()) ? 'european' : 'american');

  /** Days from nowMs to 16:00 New York on an ISO date. K is ODControls. */
  const dteTo = (isoDay, nowMs, K) => (K.nyToMs(isoDay, PM_SETTLE_MINUTES) - nowMs) / K.DAY_MS;

  /**
   * Analyser state for a journal trade. Legs keep their exact expiry: an unexpired leg carries
   * a `listed` date so its DTE follows the calendar, an expired one settles at intrinsic (dte 0).
   * Each leg's average open price becomes its "My fill"; the trade's open date, underlying and IV
   * at entry become the entry fields the position panel's attribution needs.
   * @returns {{symbol, spot, model, source, expired: number, legs: object[], entry: object}}
   */
  function toAnalyser(trade, nowMs, K) {
    const symbol = String(trade.underlying || '').toUpperCase();
    const iv = num(trade.iv_entry) && trade.iv_entry > 0 ? +trade.iv_entry : DEFAULT_IV;
    const pos = positionOf(trade);
    let expired = 0;
    const legs = pos.legs.map((l) => {
      // The average open price is my fill; the current price stays blank (theo) until typed or refreshed.
      const base = { enabled: true, kind: l.kind, long: l.qty > 0, qty: Math.abs(l.qty), iv,
        premium: null, fill: num(l.price) && l.price >= 0 ? +(+l.price).toFixed(4) : null, multiplier: l.multiplier,
        live: null, listed: null, ivOverride: false };
      if (l.kind === 'stock') return { ...base, strike: 0, dte: 0 };
      const dte = dteTo(l.expiry, nowMs, K);
      if (!(dte > 0)) { expired += 1; return { ...base, strike: l.strike, dte: 0 }; }
      return { ...base, strike: l.strike, dte,
        listed: { symbol, expiry: compact(l.expiry), trading_class: symbol } };
    });
    const spot = num(trade.underlying_entry) && trade.underlying_entry > 0 ? trade.underlying_entry : null;
    const day = typeof trade.opened_at === 'string' ? trade.opened_at.slice(0, 10) : '';
    const entry = { date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null, spot,
      iv: num(trade.iv_entry) && trade.iv_entry > 0 ? +trade.iv_entry : null };
    return { symbol, spot, model: modelFor(symbol), source: pos.source, expired, legs, entry };
  }

  /** The New York calendar day a leg expires on, as YYYY-MM-DD. */
  function legExpiry(leg, nowMs, K) {
    if (leg.listed && /^\d{8}$/.test(leg.listed.expiry)) return isoOf(leg.listed.expiry);
    if (leg.live && /^\d{8}$/.test(leg.live.expiry)) return isoOf(leg.live.expiry);
    return K.nyParts(nowMs + Math.max(leg.dte, 0) * K.DAY_MS).day;
  }

  /**
   * What the journal's new-trade form needs from the analyser's enabled legs.
   * @param {object} S analyser state
   * @param {(number|undefined)[]} theos theoretical price per leg (same order as S.legs)
   */
  function toPrefill(S, theos, nowMs, K) {
    const picked = S.legs.map((l, i) => ({ l, theo: theos[i] })).filter(({ l }) => l.enabled && l.qty > 0);
    const options = picked.filter(({ l }) => l.kind !== 'stock');
    const ivs = options.map(({ l }) => l.iv).filter(num);
    const legs = picked.map(({ l, theo }) => {
      // A fill is what I really paid; otherwise the price, as before.
      const price = num(l.fill) ? l.fill : num(l.premium) ? l.premium : l.kind === 'stock' ? S.spot : theo;
      return { kind: l.kind, side: l.long ? 'buy' : 'sell', qty: l.qty,
        strike: l.kind === 'stock' ? null : l.strike,
        expiry: l.kind === 'stock' ? null : legExpiry(l, nowMs, K),
        price: num(price) ? +(+price).toFixed(4) : null };
    });
    return { underlying: String(S.symbol || '').toUpperCase(), underlying_entry: num(S.spot) ? S.spot : null,
      iv_entry: ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(2) : null, legs };
  }

  const STRATEGY_WORDS = (s) => String(s || '').replace(/_/g, ' ');
  const tradeLabel = (trade) => `#${trade.id} ${trade.underlying} ${STRATEGY_WORDS(trade.strategy)}`.trim();

  /** The trade id in ?journal_trade=N, or null. */
  function tradeIdFrom(search) {
    const raw = new URLSearchParams(search || '').get('journal_trade');
    return raw && /^\d{1,9}$/.test(raw) ? +raw : null;
  }

  const api = { PREFILL_KEY, positionOf, toAnalyser, toPrefill, legExpiry, modelFor, tradeLabel, tradeIdFrom };
  root.ODJournal = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
