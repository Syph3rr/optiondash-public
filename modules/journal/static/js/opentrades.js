/* Rows for the "Open trades" card on Home: the journal's open trades, nearest expiry first.
   Pure. window.OpenTrades / Node. Input is GET /api/journal/trades (trade views). */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OpenTrades = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const utc = (iso) => {
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const finite = (v) => typeof v === "number" && Number.isFinite(v);

  /** Earliest expiry among legs still held (net quantity not zero); null for stock only. */
  function nextExpiry(legs) {
    const live = (legs || []).filter((l) => l && l.expiry && l.net_qty).map((l) => String(l.expiry).slice(0, 10));
    return live.length ? live.sort()[0] : null;
  }

  /**
   * [{id, underlying, strategy, expiry, dte, risk, unlimited, cash, daysHeld, pnl}], open trades
   * only, nearest expiry first (no expiry last), then oldest id. `risk` is the current max loss,
   * or the trade's own max-risk figure; `unlimited` when neither bounds the loss.
   */
  function rows(trades, todayIso) {
    const today = utc(todayIso);
    return (Array.isArray(trades) ? trades : [])
      .filter((t) => t && t.status === "open")
      .map((t) => {
        const expiry = nextExpiry(t.legs);
        const current = t.current && finite(t.current.max_loss) ? t.current.max_loss : null;
        const risk = current ?? (finite(t.max_risk_override) ? t.max_risk_override : null);
        return {
          id: t.id, underlying: t.underlying, strategy: t.strategy, expiry,
          dte: expiry ? Math.round((utc(expiry) - today) / DAY_MS) : null,
          risk, unlimited: risk === null,
          cash: finite(t.cash_flow) ? t.cash_flow : null,
          daysHeld: finite(t.days_held) ? t.days_held : null,
          pnl: finite(t.pnl) ? t.pnl : null,
        };
      })
      .sort((a, b) => {
        if (a.expiry !== b.expiry) {
          if (a.expiry === null) return 1;
          if (b.expiry === null) return -1;
          return a.expiry < b.expiry ? -1 : 1;
        }
        return a.id - b.id;
      });
  }

  return { rows, nextExpiry };
});
