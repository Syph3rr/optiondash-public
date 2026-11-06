// Pure helpers for the Chain & screener page: pivot a chain, find the ATM strike, the implied
// move, the skew, and filter contracts. No DOM, no network; the page code is page.js.
// Node tests load this file directly. Nothing here changes its input.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Chain = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const round2 = (x) => Math.round(x * 100) / 100;
  const validRow = (r) => !!r && num(r.strike) && (r.right === 'C' || r.right === 'P');

  /** Rows from /api/market/chain joined by strike: [{strike, call, put}] sorted by strike. */
  function pivot(rows) {
    const by = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!validRow(r)) continue;
      const cur = by.get(r.strike) || { strike: r.strike, call: null, put: null };
      by.set(r.strike, { ...cur, [r.right === 'C' ? 'call' : 'put']: r });
    }
    return [...by.values()].sort((a, b) => a.strike - b.strike);
  }

  /** The strike nearest spot, or null for an empty table. */
  function atmStrike(table, spot) {
    let best = null;
    for (const r of table) {
      if (best === null || Math.abs(r.strike - spot) < Math.abs(best - spot)) best = r.strike;
    }
    return best;
  }

  /** ATM straddle: the market's implied move for this expiry. Null without both marks. */
  function expectedMove(table, spot) {
    const k = atmStrike(table, spot);
    const row = table.find((r) => r.strike === k);
    if (!row || !row.call || !row.put || !num(row.call.mark) || !num(row.put.mark) || !(spot > 0)) return null;
    const dollars = round2(row.call.mark + row.put.mark);
    return { strike: k, dollars, pct: round2((dollars / spot) * 100) };
  }

  /** IV by strike from out-of-the-money options: puts below spot, calls at or above it. */
  function skew(table, spot) {
    const out = [];
    for (const r of table) {
      const q = r.strike < spot ? r.put : r.call;
      if (q && num(q.iv) && q.iv > 0) out.push({ strike: r.strike, iv: q.iv });
    }
    return out;
  }

  /** (ask - bid) over mark, in percent to 2 dp. Null when it cannot be known. */
  function spreadPct(q) {
    if (!num(q.bid) || !num(q.ask) || !num(q.mark) || q.mark <= 0 || q.ask < q.bid) return null;
    return round2(((q.ask - q.bid) / q.mark) * 100);
  }

  const KEYS = {
    strike: (r) => r.strike, iv: (r) => r.iv, mark: (r) => r.mark, bid: (r) => r.bid,
    spread: (r) => r.spreadPct, delta: (r) => (num(r.delta) ? Math.abs(r.delta) : null),
    dte: (r) => r.dte,
  };

  /**
   * Contracts passing every filter given. A filter on a value the contract lacks excludes it.
   * Filters: side 'C'|'P'|'' , deltaMin/deltaMax (absolute delta), minBid, minMark,
   * maxSpreadPct, ivMin/ivMax (fractions). Returns new rows with `spreadPct` added.
   */
  function screen(rows, f = {}, sort = {}) {
    const has = (x) => x !== undefined && x !== null && x !== '';
    const need = (value, ok) => num(value) && ok(value);
    const out = (Array.isArray(rows) ? rows : []).filter(validRow)
      .map((r) => ({ ...r, spreadPct: spreadPct(r) }))
      .filter((r) => {
        const d = num(r.delta) ? Math.abs(r.delta) : null;
        return (!f.side || r.right === f.side)
          && (!has(f.deltaMin) || need(d, (v) => v >= f.deltaMin))
          && (!has(f.deltaMax) || need(d, (v) => v <= f.deltaMax))
          && (!has(f.minBid) || need(r.bid, (v) => v >= f.minBid))
          && (!has(f.minMark) || need(r.mark, (v) => v >= f.minMark))
          && (!has(f.maxSpreadPct) || need(r.spreadPct, (v) => v <= f.maxSpreadPct))
          && (!has(f.ivMin) || need(r.iv, (v) => v >= f.ivMin))
          && (!has(f.ivMax) || need(r.iv, (v) => v <= f.ivMax));
      });
    const key = KEYS[sort.key] || KEYS.strike;
    const dir = sort.dir === 'desc' ? -1 : 1;
    // Rows without the sort value go last whichever way the list runs.
    return out.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
      if (y === null || y === undefined) return -1;
      return (x - y) * dir || a.strike - b.strike;
    });
  }

  const VIEWS = Object.freeze(['chart', 'chain', 'skew', 'screener']);

  /** The tab to open with: a remembered one (the URL hash, "#skew" or "skew") or else the chart. */
  function initialView(saved) {
    const v = String(saved || '').replace(/^#/, '').toLowerCase();
    return VIEWS.includes(v) ? v : 'chart';
  }

  return { pivot, atmStrike, expectedMove, skew, spreadPct, screen, VIEWS, initialView };
});
