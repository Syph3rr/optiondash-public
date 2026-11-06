// Pure rules for legs linked to market data: what a quote may change, and what an edit unlinks.
// Loaded in the browser as window.ODRules and in Node tests through module.exports.
// IV is a percent in legs and a decimal in quotes. Every function returns new objects.
(function (root) {
  'use strict';
  const STALE_MS = 30000;
  const POLL_LIVE_MS = 2000;
  const POLL_SLOW_MS = 5000;
  const IV_MOVE = 0.01;
  const DTE_MOVE = 0.002;
  const EPS = 1e-9;
  const LINK_KEYS = ['symbol', 'expiry', 'strike', 'right', 'trading_class'];

  const known = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(+x);
  const blank = (x) => x === null || x === undefined || x === '';
  const pct = (iv) => Math.round(iv * 10000) / 100;
  const link = (q) => Object.fromEntries(LINK_KEYS.map((k) => [k, q[k] ?? null]));
  /** The listed expiry a contract sits on, so a leg unlinked by an edit keeps its date. */
  const listingOf = (c) => (c ? { symbol: c.symbol, expiry: c.expiry, trading_class: c.trading_class } : null);
  const matches = (leg, q) => !!leg.live && LINK_KEYS.every((k) => (leg.live[k] ?? null) === (q[k] ?? null));

  /** @returns {object} a new leg for a chain pick; the caller assigns the id */
  function legFromQuote(q, long) {
    return {
      enabled: true, kind: q.right === 'C' ? 'call' : 'put', long: !!long, qty: 1,
      strike: q.strike, dte: known(q.dte) ? +q.dte : 0, iv: known(q.iv) ? pct(+q.iv) : null,
      premium: known(q.mark) ? +q.mark : null, multiplier: known(q.multiplier) ? +q.multiplier : 100,
      live: link(q), listed: listingOf(q), ivOverride: false,
    };
  }

  /** Refresh: updates only dte and IV (unless overridden); never premium, strike or expiry. */
  function applyQuote(leg, q) {
    if (!q || !matches(leg, q)) return leg;
    if (known(q.dte) && +q.dte <= 0) return { ...leg, live: null, listed: null, dte: 0 };
    return {
      ...leg,
      dte: known(q.dte) ? +q.dte : leg.dte,
      iv: !leg.ivOverride && known(q.iv) ? pct(+q.iv) : leg.iv,
    };
  }

  /** Link an existing leg to a quote the user picked. */
  function syncLeg(leg, q, spot) {
    if (leg.kind === 'stock') {
      return blank(leg.premium) && known(spot) ? { ...leg, premium: +spot } : leg;
    }
    if (!q || (known(q.dte) && +q.dte <= 0)) return leg;
    return {
      ...leg,
      strike: q.strike,
      dte: known(q.dte) ? +q.dte : leg.dte,
      iv: !leg.ivOverride && known(q.iv) ? pct(+q.iv) : leg.iv,
      premium: blank(leg.premium) && known(q.mark) ? +q.mark : leg.premium,
      multiplier: known(q.multiplier) ? +q.multiplier : leg.multiplier,
      live: link(q),
      listed: listingOf(q),
    };
  }

  /**
   * A typed strike, DTE or kind breaks the link; a typed IV pins the IV but keeps it. Only a typed
   * DTE forgets the expiry date the leg was on: the leg is then a custom what-if.
   */
  function onEdit(leg, field) {
    if (field === 'dte') return { ...leg, live: null, listed: null };
    if (field === 'strike' || field === 'kind') {
      const listed = leg.kind === 'stock' ? null : listingOf(leg.live) || leg.listed || null;
      return { ...leg, live: null, listed };
    }
    if (field === 'iv') return { ...leg, ivOverride: true };
    return leg;
  }

  /**
   * Puts a leg on a listed expiry chosen by date. Sync links exactly that expiry, so the DTE no
   * longer has to guess it. A link to another expiry is broken; a link to this one is kept.
   * @param {{expiry: string, trading_class: string}} e one listed expiry of `symbol`
   * @param {number} dte days from now to its settlement
   */
  function pickExpiry(leg, e, symbol, dte) {
    const listed = { symbol, expiry: e.expiry, trading_class: e.trading_class };
    const same = !!leg.live && leg.live.symbol === symbol && leg.live.expiry === e.expiry
      && leg.live.trading_class === e.trading_class;
    return { ...leg, dte, listed, live: same ? leg.live : null };
  }

  const clearIvOverride = (leg) => ({ ...leg, ivOverride: false });

  const other = (c, symbol) => !!c && c.symbol !== symbol;

  /** Unlinks every leg that is not linked to this symbol, and forgets dates picked for another. */
  const unlinkOthers = (legs, symbol) => legs.map((l) => (other(l.live, symbol) || other(l.listed, symbol)
    ? { ...l, live: other(l.live, symbol) ? null : l.live, listed: other(l.listed, symbol) ? null : l.listed }
    : l));

  const differs = (x, y, tol) => (known(x) && known(y) ? Math.abs(x - y) >= tol - EPS : x !== y);

  /** @returns {boolean} true when the leg lists differ enough to redraw the payoff */
  function moved(a, b) {
    if (a.length !== b.length) return true;
    return a.some((l, i) => differs(l.iv, b[i].iv, IV_MOVE) || differs(l.dte, b[i].dte, DTE_MOVE));
  }

  const nextPollMs = (quotes) =>
    quotes.some((q) => q && q.data_type === 'live') ? POLL_LIVE_MS : POLL_SLOW_MS;

  const isStale = (asOfMs, nowMs) => !Number.isFinite(asOfMs) || nowMs - asOfMs > STALE_MS;

  const api = {
    STALE_MS, blank, legFromQuote, applyQuote, syncLeg, onEdit, pickExpiry, clearIvOverride,
    unlinkOthers, moved, nextPollMs, isStale,
  };
  root.ODRules = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
