/* Trade list filtering, sorting and headline numbers. Pure. window.Filters / Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Filters = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EMPTY = { status: "all", underlying: "", strategy: "", from: "", to: "", tag: "" };

  /** P&L shown in the list: realised when closed, else latest-mark unrealised (may be null). */
  function pnlOf(t) {
    return t.status === "closed" ? t.realized_pnl : t.unrealized_pnl;
  }

  function matches(t, f) {
    if (f.status && f.status !== "all" && t.status !== f.status) return false;
    if (f.underlying && !t.underlying.toUpperCase().includes(f.underlying.trim().toUpperCase())) return false;
    if (f.strategy && t.strategy !== f.strategy) return false;
    if (f.from && t.opened_at < f.from) return false;
    if (f.to && t.opened_at > f.to) return false;
    if (f.tag) {
      const want = f.tag.trim().toLowerCase();
      if (want && !(t.tags || []).some((tag) => tag.value.includes(want))) return false;
    }
    return true;
  }

  function filterTrades(trades, filters) {
    const f = { ...EMPTY, ...filters };
    return (trades || []).filter((t) => matches(t, f));
  }

  const SORT_KEYS = {
    id: (t) => t.id,
    opened_at: (t) => t.opened_at,
    underlying: (t) => t.underlying,
    strategy: (t) => t.strategy,
    account_name: (t) => t.account_name,
    dte_at_entry: (t) => t.dte_at_entry,
    days_held: (t) => t.days_held,
    status: (t) => t.status,
    pnl: pnlOf,
    return_on_risk: (t) => t.return_on_risk,
    confidence: (t) => t.confidence,
  };

  /** Returns a new array. Nulls always sort last, whichever direction. */
  function sortTrades(trades, key, dir = "desc") {
    const get = SORT_KEYS[key] || SORT_KEYS.opened_at;
    const mul = dir === "asc" ? 1 : -1;
    return [...(trades || [])].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const na = va === null || va === undefined;
      const nb = vb === null || vb === undefined;
      if (na || nb) return na === nb ? b.id - a.id : na ? 1 : -1;
      if (va < vb) return -mul;
      if (va > vb) return mul;
      return b.id - a.id;
    });
  }

  function headline(trades) {
    const closed = (trades || []).filter((t) => t.status === "closed");
    const wins = closed.filter((t) => t.realized_pnl > 0).length;
    return {
      open: (trades || []).length - closed.length,
      closed: closed.length,
      realized: Math.round(closed.reduce((s, t) => s + (t.realized_pnl || 0), 0) * 100) / 100,
      winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    };
  }

  return { EMPTY, pnlOf, filterTrades, sortTrades, headline };
});
