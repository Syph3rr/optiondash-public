/* Strategy templates and shape recognition. Pure: no DOM. window.Strategies / Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Strategies = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // side: buy|sell, ratio: units per "contract" of the strategy, group: which expiry box it uses.
  const L = (side, kind, ratio, hint, group = "front") => ({ side, kind, ratio, hint, group });

  const TEMPLATES = {
    long_call: [L("buy", "call", 1, "strike")],
    long_put: [L("buy", "put", 1, "strike")],
    short_call: [L("sell", "call", 1, "strike")],
    short_put: [L("sell", "put", 1, "strike")],
    cash_secured_put: [L("sell", "put", 1, "strike")],
    covered_call: [L("buy", "stock", 100, "shares"), L("sell", "call", 1, "OTM call")],
    bull_call_spread: [L("buy", "call", 1, "lower strike"), L("sell", "call", 1, "higher strike")],
    bear_call_spread: [L("sell", "call", 1, "lower strike"), L("buy", "call", 1, "higher strike")],
    bull_put_spread: [L("sell", "put", 1, "higher strike"), L("buy", "put", 1, "lower strike")],
    bear_put_spread: [L("buy", "put", 1, "higher strike"), L("sell", "put", 1, "lower strike")],
    iron_condor: [
      L("buy", "put", 1, "long put (lowest)"), L("sell", "put", 1, "short put"),
      L("sell", "call", 1, "short call"), L("buy", "call", 1, "long call (highest)"),
    ],
    iron_butterfly: [
      L("buy", "put", 1, "long put (wing)"), L("sell", "put", 1, "short put (body)"),
      L("sell", "call", 1, "short call (same body)"), L("buy", "call", 1, "long call (wing)"),
    ],
    long_butterfly: [
      L("buy", "call", 1, "lower wing"), L("sell", "call", 2, "body"), L("buy", "call", 1, "upper wing"),
    ],
    broken_wing_butterfly: [
      L("buy", "put", 1, "upper wing"), L("sell", "put", 2, "body"), L("buy", "put", 1, "lower wing (wider)"),
    ],
    long_straddle: [L("buy", "put", 1, "ATM strike"), L("buy", "call", 1, "same strike")],
    short_straddle: [L("sell", "put", 1, "ATM strike"), L("sell", "call", 1, "same strike")],
    long_strangle: [L("buy", "put", 1, "OTM put"), L("buy", "call", 1, "OTM call")],
    short_strangle: [L("sell", "put", 1, "OTM put"), L("sell", "call", 1, "OTM call")],
    calendar: [L("sell", "call", 1, "strike", "front"), L("buy", "call", 1, "same strike", "back")],
    double_calendar: [
      L("sell", "put", 1, "put strike", "front"), L("buy", "put", 1, "same put strike", "back"),
      L("sell", "call", 1, "call strike", "front"), L("buy", "call", 1, "same call strike", "back"),
    ],
    diagonal: [L("sell", "call", 1, "higher strike", "front"), L("buy", "call", 1, "lower strike", "back")],
    ratio_spread: [L("buy", "call", 1, "lower strike"), L("sell", "call", 2, "higher strike")],
    jade_lizard: [
      L("sell", "put", 1, "OTM put"), L("sell", "call", 1, "short call"), L("buy", "call", 1, "higher call"),
    ],
    stock: [L("buy", "stock", 100, "shares")],
    custom: [L("buy", "call", 1, "")],
  };

  const MULTI_EXPIRY = new Set(["calendar", "double_calendar", "diagonal"]);

  function template(id) {
    return (TEMPLATES[id] || TEMPLATES.custom).map((leg) => ({ ...leg }));
  }

  function usesTwoExpiries(id) {
    return MULTI_EXPIRY.has(id);
  }

  // ---------- recognition -------------------------------------------------------------

  const sign = (q) => (q > 0 ? 1 : q < 0 ? -1 : 0);

  /**
   * Merge legs on the same contract (kind, strike, expiry), summing qty, so an order that
   * filled in pieces reads as one leg. Legs that net to zero are dropped.
   */
  function mergeLegs(rawLegs) {
    const merged = new Map();
    for (const l of rawLegs || []) {
      if (!l || !l.qty) continue;
      const key = l.kind === "stock" ? "stock" : `${l.kind}|${l.strike}|${l.expiry}`;
      const prev = merged.get(key);
      merged.set(key, prev ? { ...prev, qty: prev.qty + l.qty } : { kind: l.kind, strike: l.strike, expiry: l.expiry, qty: l.qty });
    }
    return [...merged.values()]
      .map((l) => ({ ...l, qty: Math.round(l.qty * 1e6) / 1e6 }))
      .filter((l) => l.qty !== 0);
  }

  /** Legs: [{kind, strike, expiry, qty (signed)}]. Returns a strategy id. */
  function guessStrategy(rawLegs) {
    const legs = mergeLegs(rawLegs);
    const stock = legs.filter((l) => l.kind === "stock");
    const opts = legs.filter((l) => l.kind !== "stock").sort((a, b) => a.strike - b.strike);
    if (!legs.length) return "custom";
    if (stock.length && !opts.length) return "stock";
    if (stock.length) {
      if (opts.length === 1 && opts[0].kind === "call" && opts[0].qty < 0 && stock[0].qty > 0) return "covered_call";
      return "custom";
    }
    if (opts.length === 1) return single(opts[0]);
    const expiries = new Set(opts.map((l) => l.expiry));
    if (opts.length === 2) return two(opts, expiries.size);
    if (opts.length === 3 && expiries.size === 1) return three(opts);
    if (opts.length === 4) return four(opts, expiries.size);
    return "custom";
  }

  function single(l) {
    return `${l.qty > 0 ? "long" : "short"}_${l.kind}`;
  }

  function two([a, b], nExpiries) {
    const sameKind = a.kind === b.kind;
    const opposite = sign(a.qty) !== sign(b.qty);
    if (nExpiries === 2) {
      if (!sameKind || !opposite) return "custom";
      return a.strike === b.strike ? "calendar" : "diagonal";
    }
    if (sameKind && opposite) {
      if (Math.abs(a.qty) !== Math.abs(b.qty)) return "ratio_spread";
      const lowerLong = a.qty > 0; // a has the lower strike
      if (a.kind === "call") return lowerLong ? "bull_call_spread" : "bear_call_spread";
      return lowerLong ? "bull_put_spread" : "bear_put_spread";
    }
    if (!sameKind && !opposite) {
      const prefix = a.qty > 0 ? "long" : "short";
      return a.strike === b.strike ? `${prefix}_straddle` : `${prefix}_strangle`;
    }
    return "custom";
  }

  function three(opts) {
    const [lo, mid, hi] = opts;
    const sameKind = opts.every((l) => l.kind === lo.kind);
    if (sameKind && lo.qty > 0 && hi.qty > 0 && mid.qty === -(lo.qty + hi.qty) && lo.qty === hi.qty) {
      const lower = mid.strike - lo.strike;
      const upper = hi.strike - mid.strike;
      return Math.abs(lower - upper) < 1e-9 ? "long_butterfly" : "broken_wing_butterfly";
    }
    const puts = opts.filter((l) => l.kind === "put");
    const calls = opts.filter((l) => l.kind === "call");
    if (puts.length === 1 && calls.length === 2 && puts[0].qty < 0) {
      const [c1, c2] = calls;
      if (c1.qty < 0 && c2.qty > 0 && c1.qty === -c2.qty) return "jade_lizard";
    }
    return "custom";
  }

  function four(opts, nExpiries) {
    const puts = opts.filter((l) => l.kind === "put");
    const calls = opts.filter((l) => l.kind === "call");
    if (puts.length !== 2 || calls.length !== 2) return "custom";
    if (nExpiries === 2) {
      const cal = (pair) => pair[0].strike === pair[1].strike && sign(pair[0].qty) !== sign(pair[1].qty);
      return cal(puts) && cal(calls) ? "double_calendar" : "custom";
    }
    if (nExpiries !== 1) return "custom";
    const [pLo, pHi] = puts; // sorted by strike already
    const [cLo, cHi] = calls;
    if (pLo.qty > 0 && pHi.qty < 0 && cLo.qty < 0 && cHi.qty > 0) {
      return pHi.strike === cLo.strike ? "iron_butterfly" : "iron_condor";
    }
    return "custom";
  }

  return { TEMPLATES, template, usesTwoExpiries, guessStrategy, mergeLegs };
});
