// Pure helpers for the Portfolio page: positions grouped by journal trade inside one account.
// No DOM, no network. Needs portfolio.js (window.Portfolio, or required in Node).
//
// Broker-sourced accounts (TWS or a CSV snapshot): the account's open journal trades label the
// broker rows. Oldest trade first, each journal leg claims broker quantity on the same contract
// with the same sign, up to the leg's own quantity; the claimed part goes in that trade's group.
// What no leg claims is "Not in journal"; what a leg could not claim is a missing line.
// Journal-sourced accounts: each open trade is a group of its own legs.
(function (root, factory) {
  const P = typeof module !== 'undefined' && module.exports ? require('./portfolio.js') : root.Portfolio;
  const api = factory(P);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioGroups = api;
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  /** The New trade hand-off the analyser already uses (journal prefill.js reads it once). */
  const PREFILL_KEY = 'journal.prefill';
  const NEW_TRADE_URL = '/journal/?new=1&from=analyser';

  const list = (x) => (Array.isArray(x) ? x : []);
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  const tidy = (q) => (Math.abs(q) < P.EPS ? 0 : Math.round(q * 1e6) / 1e6);
  const round2 = (x) => Math.round(x * 100) / 100;

  /** A position row with its signed cost and its label. */
  const decorate = (r) => ({ ...r, cost: P.cost(r), label: P.legLabel({ ...r, symbol: String(r.symbol).toUpperCase() }) });
  const netOf = (rows) => round2(rows.reduce((s, r) => s + r.cost, 0));

  const openTrades = (trades) => list(trades)
    .filter((t) => t && t.status === 'open' && Number.isInteger(t.id) && typeof t.underlying === 'string');

  function groupOf(t, rows, missing) {
    return { trade_id: t.id, label: P.tradeLabel(t), href: P.tradeHref(t.id), underlying: t.underlying.toUpperCase(),
      strategy: typeof t.strategy === 'string' ? t.strategy : null, rows, missing, net: netOf(rows) };
  }

  const byUnderlyingThenId = (a, b) => (a.underlying < b.underlying ? -1 : a.underlying > b.underlying ? 1 : a.trade_id - b.trade_id);

  /** Claim broker quantity for one journal leg. Returns the claimed rows, the new pool and what is left unclaimed. */
  function claim(pool, leg) {
    const key = P.contractKey(leg);
    let want = leg.qty;
    const claimed = [];
    const next = pool.map((slot) => {
      if (tidy(want) === 0 || slot.key !== key || Math.sign(slot.left) !== Math.sign(want) || tidy(slot.left) === 0) return slot;
      const take = Math.sign(want) * Math.min(Math.abs(want), Math.abs(slot.left));
      want = tidy(want - take);
      claimed.push(decorate({ ...slot.row, qty: tidy(take), trade_id: leg.trade_id }));
      return { ...slot, left: tidy(slot.left - take) };
    });
    return { claimed, pool: next, left: tidy(want) };
  }

  /**
   * @param {{rows: object[], trades: object[], brokerSourced: boolean}} input rows: the account's
   *   broker rows; trades: its open journal trades (GET /api/journal/trades shape)
   * @returns {{groups: object[], unmatched: object[]}}
   */
  function groupByTrade({ rows, trades, brokerSourced }) {
    const open = openTrades(trades);
    if (!brokerSourced) {
      const groups = open.map((t) => groupOf(t, P.journalRows([t]).map(decorate), []));
      return { groups: groups.filter((g) => g.rows.length).sort(byUnderlyingThenId), unmatched: [] };
    }
    let pool = list(rows).filter(P.usable).map((row) => ({ row, key: P.contractKey(row), left: row.qty }));
    const groups = [];
    for (const t of [...open].sort((a, b) => a.id - b.id)) {
      const got = [];
      const missing = [];
      for (const leg of P.journalRows([t])) {
        const step = claim(pool, leg);
        pool = step.pool;
        got.push(...step.claimed);
        if (step.left !== 0) missing.push(decorate({ ...leg, qty: step.left }));
      }
      if (got.length || missing.length) groups.push(groupOf(t, got, missing));
    }
    const unmatched = pool.filter((s) => s.left !== 0).map((s) => decorate({ ...s.row, qty: s.left }));
    return { groups: groups.sort(byUnderlyingThenId), unmatched };
  }

  /** The New trade prefill for one position (prefill.js shape; account_id rides along for the form). */
  function prefillFor(row, accountId) {
    const kind = P.isOption(row) ? (row.kind === 'put' ? 'put' : 'call') : 'stock';
    const option = kind !== 'stock';
    return {
      underlying: String(row.symbol || '').toUpperCase(), account_id: accountId,
      legs: [{ kind, side: row.qty > 0 ? 'buy' : 'sell', qty: Math.abs(row.qty),
        strike: option ? row.strike : null, expiry: option ? String(row.expiry || '').slice(0, 10) : null,
        price: finite(row.avg_cost) && row.avg_cost >= 0 ? row.avg_cost : null }],
    };
  }

  /** Dollar delta, theta and vega summed over per-underlying engine results; null when none priced. */
  function combineGreeks(parts) {
    const priced = list(parts).filter((p) => p && p.greeks && finite(p.spot));
    if (!priced.length) return null;
    const sum = (f) => round2(priced.reduce((s, p) => s + f(p), 0));
    return { dollarDelta: sum((p) => (p.greeks.delta || 0) * p.spot), theta: sum((p) => p.greeks.theta || 0),
      vega: sum((p) => p.greeks.vega || 0) };
  }

  /** Sum of the finite numbers, or null when there are none. */
  function sumKnown(values) {
    const known = list(values).filter(finite);
    return known.length ? round2(known.reduce((a, b) => a + b, 0)) : null;
  }

  return { PREFILL_KEY, NEW_TRADE_URL, groupByTrade, prefillFor, combineGreeks, sumKnown };
});
