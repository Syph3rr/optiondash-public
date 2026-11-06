// Portfolio page: Load Greeks. Prices each underlying once (spot, then the held options' quotes),
// then asks the engine for whole-position Greeks per group and per underlying inside it. Runs
// only when the button is pressed: quotes come from TWS, and the page never polls.
(function () {
  'use strict';
  const P = window.Portfolio;
  const G = window.PortfolioGroups;
  const NONE = window.PortfolioSections.NONE;

  async function call(path, body) {
    const init = body === undefined ? { headers: { Accept: 'application/json' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, init);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data.error || data.message)) || `request failed (${res.status})`);
    return data;
  }

  /** One underlying: spot and the quotes for its held options. */
  async function priceSymbol(symbol, rows, rate, divYield) {
    const info = await call(`/api/market/underlying/${encodeURIComponent(symbol)}`);
    const spot = info.price;
    if (!(spot > 0)) throw new Error(`no price for ${symbol}`);
    const model = info.suggested_model || 'american';
    const replies = await Promise.all(P.quoteRequests(rows).map((b) => call('/api/market/quotes',
      { symbol, contracts: b.contracts, spot, rate, div_yield: divYield, model })));
    return { symbol, spot, model, quotes: replies.flatMap((r) => r.quotes || []) };
  }

  /** Engine Greeks for one group's rows of one underlying: { spot, greeks, unpriced }. */
  async function greeksFor(priced, rows, rate, divYield) {
    const { legs, unpriced } = P.buildLegs(rows, priced.quotes);
    if (!legs.length) return { spot: priced.spot, greeks: null, unpriced: unpriced.length };
    const out = await call('/api/analyze', { spot: priced.spot, rate, div_yield: divYield, model: priced.model,
      legs, n_prices: 41, n_dates: 6 });
    return { spot: priced.spot, greeks: (out.summary && out.summary.now) || null, unpriced: unpriced.length };
  }

  const groupsOf = (view) => view.grouped.groups.map((g) => ({ key: g.trade_id, rows: g.rows }))
    .concat(view.grouped.unmatched.length ? [{ key: NONE, rows: view.grouped.unmatched }] : []);

  /**
   * Price every shown position.
   * @returns {Promise<{live: object, total: object, notes: string[]}>} live is what sections.js draws with
   */
  async function price(views, rate, divYield) {
    const allRows = views.flatMap((v) => groupsOf(v).flatMap((g) => g.rows));
    const symbols = [...new Set(allRows.map((r) => r.symbol))];
    const results = await Promise.all(symbols.map((s) => priceSymbol(s, allRows.filter((r) => r.symbol === s), rate, divYield)
      .catch((e) => ({ symbol: s, error: e.message }))));
    const bySym = new Map(results.map((r) => [r.symbol, r]));
    const markFor = (row) => {
      const r = bySym.get(row.symbol);
      if (!r || r.error) return null;
      return row.sec_type === 'STK' ? { mark: r.spot } : P.findQuote(r.quotes, row);
    };
    const notes = results.filter((r) => r.error).map((r) => `${r.symbol}: ${r.error}`);
    const groupStats = new Map();
    const accountParts = new Map();
    await Promise.all(views.flatMap((v) => groupsOf(v).map(async (g) => {
      const syms = [...new Set(g.rows.map((r) => r.symbol))].filter((s) => !bySym.get(s).error);
      const parts = await Promise.all(syms.map((s) => greeksFor(bySym.get(s), g.rows.filter((r) => r.symbol === s), rate, divYield)
        .catch((e) => { notes.push(`${s}: ${e.message}`); return null; })));
      const pnl = G.sumKnown(g.rows.map((r) => { const q = markFor(r); return q ? P.unrealised(r, q) : null; }));
      const ok = parts.filter(Boolean);
      groupStats.set(`${v.account.id}:${g.key}`, { greeks: G.combineGreeks(ok), pnl,
        unpriced: ok.reduce((s, p) => s + p.unpriced, 0) });
      const acc = accountParts.get(v.account.id) || { parts: [], pnls: [] };
      accountParts.set(v.account.id, { parts: acc.parts.concat(ok), pnls: acc.pnls.concat([pnl]) });
    })));
    const statsOf = (entry) => ({ greeks: G.combineGreeks(entry.parts), pnl: G.sumKnown(entry.pnls),
      unpriced: entry.parts.reduce((s, p) => s + p.unpriced, 0) });
    const accounts = new Map([...accountParts].map(([id, entry]) => [id, statsOf(entry)]));
    const everything = [...accountParts.values()].reduce((a, e) => ({ parts: a.parts.concat(e.parts), pnls: a.pnls.concat(e.pnls) }),
      { parts: [], pnls: [] });
    const total = statsOf(everything);
    if (total.unpriced) notes.unshift(`${total.unpriced} option leg(s) had no price or IV and are not in these Greeks.`);
    return {
      live: { markFor, group: (accountId, key) => groupStats.get(`${accountId}:${key}`) || null,
        account: (accountId) => accounts.get(accountId) || null },
      total,
      notes,
    };
  }

  window.PortfolioGreeks = { price };
})();
