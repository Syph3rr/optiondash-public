// My fills vs current prices: unrealised P&L per leg and a since-entry attribution.
// Pure helpers: no DOM, no fetch. Loaded in the browser as window.ODPosition and in Node
// tests through module.exports. Every function returns new objects.
//
// Prices are per share (per unit); dollars use qty x multiplier x side (+1 bought, -1 sold).
//
// Attribution method: exact repricing, not Greeks. The engine (/api/analyze) prices any leg at a
// chosen spot, IV and DTE, and reports each leg's theoretical value (`legs[i].theo`), so each
// filled leg is repriced at four states and the steps between them are the parts of the move:
//   V0 entry spot, entry IV, entry DTE    (DTE at entry = DTE now + days held)
//   V1 spot now,   entry IV, entry DTE    V1 - V0 = underlying move (delta, gamma and beyond)
//   V2 spot now,   entry IV, DTE now      V2 - V1 = time decay
//   V3 spot now,   IV now,   DTE now      V3 - V2 = IV change
//   other = (current - my fill) - (V3 - V0): what the model does not explain, mostly the gap
//   between my fill and the model value at entry (edge, spread, a different entry IV per leg)
//   and between the current market price and the model value now.
// A Taylor expansion (delta x dS + 1/2 gamma x dS^2 + theta x days + vega x dIV) drifts badly on big
// moves and near expiry; repricing is exact for the model and needs only two requests: one at the
// entry spot (V0) and one at today's spot holding V1, V2 and V3 as three copies of each leg.
// The order (spot, then time, then IV) is a choice: cross effects land in the later steps.
//
// IV at entry is one number for the position (the journal keeps one). Each leg's entry IV is its
// IV now shifted by (IV at entry - mean IV now of the option legs), so skew between strikes is kept
// and the IV step is the change in the position's average IV.
//
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("position.js", JS, "../modules/analyser/web/position.js"),
(function (root) {
  'use strict';

  const MIN_IV = 0.5;                 // percent, as the engine's floor
  const OPEN_MINUTES = 570;           // 09:30 New York: the journal's charts also start here
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const RIGHTS = { call: 'C', put: 'P' };
  const REPRICE = { iv_shift: 0, range: 0.05, n_prices: 21, n_dates: 2, at_days: [] };

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const sideOf = (l) => (l.long ? 1 : -1);
  const scaleOf = (l) => sideOf(l) * l.qty * l.multiplier;
  const inPosition = (l) => !!l && l.enabled !== false && num(l.qty) && l.qty > 0;
  const hasFill = (l) => num(l.fill) && l.fill >= 0;

  /** True when any leg in the position has a fill: P&L is then measured from the fills. */
  const hasFills = (legs) => (legs || []).some((l) => inPosition(l) && hasFill(l));

  /** The premium the pricing engine should use as cost basis: my fill, else the leg's price. */
  const basisOf = (l) => (hasFill(l) ? l.fill : l.premium);

  /** The current per-share price: the stock trades at spot; an option at its price, else theo. */
  function currentOf(l, theo, spot) {
    if (l.kind === 'stock') return num(spot) ? spot : null;
    if (num(l.premium)) return l.premium;
    return num(theo) ? theo : null;
  }

  function legLabel(l) {
    const side = l.long ? 'BUY' : 'SELL';
    if (l.kind === 'stock') return `${side} ${l.qty} stock`;
    return `${side} ${l.qty} ${l.strike} ${l.kind === 'call' ? 'call' : 'put'}`;
  }

  /**
   * One row per leg in the position, in S.legs order.
   * @param {number[]} theos theo now per leg (same order as legs; undefined where unknown)
   * @returns {{index, label, fill, current, change, pnl}[]} change and pnl are null without a fill
   */
  function positionRows(legs, theos, spot) {
    return legs.map((l, index) => ({ l, index })).filter(({ l }) => inPosition(l)).map(({ l, index }) => {
      const current = currentOf(l, theos[index], spot);
      const fill = hasFill(l) ? l.fill : null;
      const change = fill !== null && current !== null ? current - fill : null;
      return { index, label: legLabel(l), fill, current, change,
        pnl: change === null ? null : change * scaleOf(l) };
    });
  }

  /** @returns {{pnl: number, filled: number, unpriced: number}} */
  function totals(rows) {
    const filled = rows.filter((r) => r.fill !== null);
    return { pnl: filled.reduce((a, r) => a + (r.pnl ?? 0), 0), filled: filled.length,
      unpriced: filled.filter((r) => r.pnl === null).length };
  }

  // ------------------------------------------------------------------ entry
  /**
   * What the attribution needs from the entry fields. K is ODControls (New York time).
   * @returns {{ok: boolean, missing: string[], daysHeld: number|null}}
   */
  function entryCheck(entry, nowMs, K) {
    const e = entry || {};
    const missing = [];
    if (!(typeof e.date === 'string' && DAY_RE.test(e.date))) missing.push('entry date');
    if (!(num(e.spot) && e.spot > 0)) missing.push('underlying at entry');
    if (!(num(e.iv) && e.iv > 0)) missing.push('IV at entry');
    if (missing.length) return { ok: false, missing, daysHeld: null };
    const daysHeld = Math.max(0, (nowMs - K.nyToMs(e.date, OPEN_MINUTES)) / K.DAY_MS);
    return { ok: true, missing, daysHeld };
  }

  /** Each leg's IV at entry, in percent: its IV now, shifted so the option legs' mean matches. */
  function entryIvs(legs, ivAtEntry) {
    const opts = legs.filter((l) => l.kind !== 'stock');
    const mean = opts.length ? opts.reduce((a, l) => a + l.iv, 0) / opts.length : ivAtEntry;
    return legs.map((l) => (l.kind === 'stock' ? l.iv : Math.max(MIN_IV, l.iv + ivAtEntry - mean)));
  }

  // ------------------------------------------------------------------ repricing requests
  const unitLeg = (l, dte, iv) => ({ kind: l.kind, long: true, qty: 1, strike: l.kind === 'stock' ? 0 : l.strike,
    dte: l.kind === 'stock' ? 0 : Math.max(0, dte), iv: iv / 100, premium: null, multiplier: 1, enabled: true });

  const market = (S, spot) => ({ spot, rate: S.rate / 100, div_yield: S.divy / 100, model: S.model, ...REPRICE });

  /**
   * /api/analyze bodies that reprice the position's legs. `now` always holds the legs at today's
   * spot, DTE and IV (V3). With a complete entry, `now` also holds V1 and V2 and `entry` holds V0.
   * @returns {{legs: number[], now: object, entry: object|null}} legs = S.legs indexes priced
   */
  function repricingBodies(S, check) {
    const picked = S.legs.map((l, i) => ({ l, i })).filter(({ l }) => inPosition(l));
    const legs = picked.map(({ l }) => l);
    const v3 = legs.map((l) => unitLeg(l, l.dte, l.iv));
    if (!check || !check.ok) return { legs: picked.map((p) => p.i), now: { ...market(S, S.spot), legs: v3 }, entry: null };
    const ivs = entryIvs(legs, S.entry.iv);
    const atEntry = legs.map((l, k) => unitLeg(l, l.dte + check.daysHeld, ivs[k]));
    const v2 = legs.map((l, k) => unitLeg(l, l.dte, ivs[k]));
    return { legs: picked.map((p) => p.i),
      now: { ...market(S, S.spot), legs: [...atEntry, ...v2, ...v3] },
      entry: { ...market(S, S.entry.spot), legs: atEntry } };
  }

  /** Theo per leg from a reply, in blocks of n (one block per priced state). */
  function theoBlocks(reply, n) {
    const theo = (reply && Array.isArray(reply.legs) ? reply.legs : []).map((x) => (x && num(x.theo) ? x.theo : null));
    const blocks = [];
    for (let at = 0; at + n <= theo.length && n > 0; at += n) blocks.push(theo.slice(at, at + n));
    return blocks;
  }

  /** Theo now (V3) per S.legs index, from the `now` reply. */
  function theosNow(S, priced, nowReply) {
    const blocks = theoBlocks(nowReply, priced.legs.length);
    const v3 = blocks[blocks.length - 1] || [];
    const out = S.legs.map(() => undefined);
    priced.legs.forEach((legIndex, k) => { out[legIndex] = v3[k] ?? undefined; });
    return out;
  }

  /**
   * The since-entry split of the filled legs' unrealised P&L, in dollars.
   * @returns {{move, time, iv, other, total}|null} null when a price is missing
   */
  function attribution(S, priced, rows, entryReply, nowReply) {
    const n = priced.legs.length;
    const [v0] = theoBlocks(entryReply, n);
    const [v1, v2, v3] = theoBlocks(nowReply, n);
    if (!v0 || !v3) return null;
    const out = { move: 0, time: 0, iv: 0, other: 0, total: 0 };
    for (const row of rows.filter((r) => r.fill !== null)) {
      const k = priced.legs.indexOf(row.index);
      const vals = [v0[k], v1[k], v2[k], v3[k]];
      if (k < 0 || row.pnl === null || !vals.every(num)) return null;
      const scale = scaleOf(S.legs[row.index]);
      out.move += (vals[1] - vals[0]) * scale;
      out.time += (vals[2] - vals[1]) * scale;
      out.iv += (vals[3] - vals[2]) * scale;
      out.total += row.pnl;
    }
    return { ...out, other: out.total - out.move - out.time - out.iv };
  }

  // ------------------------------------------------------------------ live prices
  /** The listed contract a leg stands for: its link, else its picked date and strike. */
  function contractFor(l, symbol) {
    if (l.kind === 'stock') return null;
    if (l.live) return l.live;
    const d = l.listed;
    if (!d || d.symbol !== symbol || !num(l.strike) || l.strike <= 0) return null;
    return { symbol: d.symbol, expiry: d.expiry, strike: l.strike, right: RIGHTS[l.kind], trading_class: d.trading_class };
  }

  const keyOf = (c) => [c.symbol, c.expiry, +c.strike, c.right, c.trading_class].join('|');

  /** Contracts to quote, each once, for this symbol. */
  function contractsToQuote(legs, symbol, max = 32) {
    const seen = new Map();
    legs.filter(inPosition).map((l) => contractFor(l, symbol)).filter(Boolean)
      .forEach((c) => { if (!seen.has(keyOf(c))) seen.set(keyOf(c), c); });
    return [...seen.values()].slice(0, max);
  }

  /** Mid when both sides are there, else last; null when neither. */
  function priceOf(q) {
    if (!q) return null;
    if (num(q.bid) && num(q.ask) && q.bid > 0 && q.ask >= q.bid) return +((q.bid + q.ask) / 2).toFixed(4);
    if (num(q.last) && q.last > 0) return q.last;
    return null;
  }

  /** A quote's IV in percent, unless the leg's IV was typed (then the typed one stays). */
  const ivFrom = (l, q) => (!l.ivOverride && num(q.iv) && q.iv > 0 ? Math.round(q.iv * 10000) / 100 : l.iv);

  /**
   * Legs with their price (and IV, unless typed) set from the quotes that matched.
   * With `promote` (the first fetch after switching from Manual), a leg with no fill but a typed
   * premium first has that premium moved into its fill: older set-ups typed the entry price into
   * premium, and this keeps that cost basis. Later fetches only replace the market price.
   * @returns {{legs: object[], priced: number, missed: number, promoted: number}}
   */
  function applyQuotes(legs, quotes, symbol, { promote = false } = {}) {
    const byKey = new Map((Array.isArray(quotes) ? quotes : []).filter((q) => q && typeof q === 'object')
      .map((q) => [keyOf(q), q]));
    let priced = 0, missed = 0, promoted = 0;
    const next = legs.map((l) => {
      const c = inPosition(l) ? contractFor(l, symbol) : null;
      if (!c) return l;
      const q = byKey.get(keyOf(c));
      const price = priceOf(q);
      if (!num(price)) { missed += 1; return l; }
      priced += 1;
      const keep = promote && !hasFill(l) && num(l.premium) && l.premium >= 0;
      if (keep) promoted += 1;
      return { ...l, ...(keep ? { fill: l.premium } : {}), premium: price, iv: ivFrom(l, q) };
    });
    return { legs: next, priced, missed, promoted };
  }

  const api = { hasFills, basisOf, currentOf, legLabel, positionRows, totals, entryCheck, entryIvs,
    repricingBodies, theosNow, attribution, contractFor, contractsToQuote, priceOf, applyQuotes };
  root.ODPosition = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
