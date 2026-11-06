/* Client-side payoff at expiry, for the new-trade preview. Pure. window.Payoff / Node.
 * Legs: [{kind: call|put|stock, strike, qty (signed), price (entry, per share), multiplier}]
 * Every leg is settled at intrinsic value, so calendars are only approximate here;
 * the trade page uses the server's Black-Scholes curves instead. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Payoff = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EPS = 1e-9;
  const GRID = 201;

  const mult = (l) => l.multiplier || (l.kind === "stock" ? 1 : 100);

  function intrinsic(kind, s, k) {
    if (kind === "stock") return s;
    if (kind === "call") return Math.max(s - k, 0);
    return Math.max(k - s, 0);
  }

  function pnlAt(legs, s) {
    return legs.reduce((sum, l) => sum + l.qty * mult(l) * (intrinsic(l.kind, s, l.strike) - l.price), 0);
  }

  /** + credit received, − debit paid. */
  function netPremium(legs) {
    return round2(-legs.reduce((sum, l) => sum + l.qty * mult(l) * l.price, 0));
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function grid(legs, spot) {
    const anchors = legs.filter((l) => l.kind !== "stock").map((l) => l.strike);
    if (spot) anchors.push(spot);
    if (!anchors.length) anchors.push(...legs.map((l) => l.price).filter((p) => p > 0), 100);
    const lo = Math.min(...anchors) * 0.8;
    const hi = Math.max(...anchors) * 1.2;
    const pts = new Set(anchors);
    for (let i = 0; i < GRID; i++) pts.add(Math.round((lo + ((hi - lo) * i) / (GRID - 1)) * 1e4) / 1e4);
    return [...pts].sort((a, b) => a - b);
  }

  function curve(legs, spot) {
    const prices = grid(legs, spot);
    return { prices, pnl: prices.map((p) => round2(pnlAt(legs, p))) };
  }

  function breakevens(prices, pnl) {
    const out = [];
    const zero = (v) => Math.abs(v) < EPS;
    for (let i = 0; i < prices.length - 1; i++) {
      const [p0, p1, v0, v1] = [prices[i], prices[i + 1], pnl[i], pnl[i + 1]];
      if (zero(v0)) {
        // A flat run at exactly $0 adds only where P&L meets it, not every grid point on it
        // (and not the bottom of the grid, which is no breakeven). Matches app/pricing.py.
        const startsRun = i > 0 && !zero(pnl[i - 1]);
        const endsRun = !zero(v1);
        if ((startsRun || endsRun) && (!out.length || Math.abs(out[out.length - 1] - p0) > EPS)) out.push(round2(p0));
      } else if (v0 * v1 < 0) {
        out.push(round2(p0 + ((p1 - p0) * -v0) / (v1 - v0)));
      }
    }
    return out;
  }

  /** {maxProfit, maxLoss (positive), breakevens, netPremium}; null = unlimited. */
  function summarise(legs, spot) {
    if (!legs.length) return { maxProfit: 0, maxLoss: 0, breakevens: [], netPremium: 0 };
    const strikes = legs.filter((l) => l.kind !== "stock").map((l) => l.strike);
    const top = Math.max(1, spot || 0, ...strikes) * 3;
    // Start at 0: a stock or long put's extreme is at a price of exactly 0.
    const prices = [...new Set([0, ...grid(legs, spot), ...strikes, top])].sort((a, b) => a - b);
    const pnl = prices.map((p) => pnlAt(legs, p));
    const slope = legs.reduce((s, l) => s + (l.kind === "put" ? 0 : l.qty * mult(l)), 0);
    return {
      maxProfit: slope > EPS ? null : round2(Math.max(...pnl)),
      maxLoss: slope < -EPS ? null : round2(Math.max(-Math.min(...pnl), 0)),
      breakevens: breakevens(prices, pnl),
      netPremium: netPremium(legs),
    };
  }

  return { intrinsic, pnlAt, netPremium, curve, breakevens, summarise };
});
