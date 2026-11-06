/* Analyser strategy presets. Pure data, no DOM: window.ODPresets / Node.
 *
 * Every strategy the journal knows (modules/journal/static/js/strategies.js) has a preset here, so
 * what you can log on Trades you can also set up in the Analyser. tests/frontend/presets.test.cjs
 * checks that, and that each preset is recognised as the strategy it claims to be.
 *
 * A leg is [kind, long, strikeOffset, options]. strikeOffset is a fraction of spot written for 30
 * days (the page scales it with the square root of the chosen DTE). options: qty, dte (days, at the
 * 30-day scale), iv (percent).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ODPresets = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const P = (name, strategy, legs) => Object.freeze({ name, strategy, legs: Object.freeze(legs) });

  const GROUPS = Object.freeze([
    { label: 'Single leg', presets: [
      P('Long Call', 'long_call', [['call', true, 0]]),
      P('Long Put', 'long_put', [['put', true, 0]]),
      P('Short Call', 'short_call', [['call', false, 0.03]]),
      P('Short Put', 'short_put', [['put', false, -0.03]]),
      P('Cash-Secured Put', 'cash_secured_put', [['put', false, -0.03]]),
      P('Stock', 'stock', [['stock', true, 0, { qty: 100 }]]),
      P('Covered Call', 'covered_call', [['stock', true, 0, { qty: 100 }], ['call', false, 0.04]]),
    ] },
    { label: 'Vertical spreads', presets: [
      P('Bull Call Spread', 'bull_call_spread', [['call', true, 0], ['call', false, 0.04]]),
      P('Bear Call Spread', 'bear_call_spread', [['call', false, 0.02], ['call', true, 0.05]]),
      P('Bull Put Spread', 'bull_put_spread', [['put', false, -0.02], ['put', true, -0.05]]),
      P('Bear Put Spread', 'bear_put_spread', [['put', true, 0], ['put', false, -0.04]]),
    ] },
    { label: 'Straddles & strangles', presets: [
      P('Long Straddle', 'long_straddle', [['call', true, 0], ['put', true, 0]]),
      P('Short Straddle', 'short_straddle', [['call', false, 0], ['put', false, 0]]),
      P('Long Strangle', 'long_strangle', [['put', true, -0.05], ['call', true, 0.05]]),
      P('Short Strangle', 'short_strangle', [['put', false, -0.05], ['call', false, 0.05]]),
    ] },
    { label: 'Condors & butterflies', presets: [
      P('Iron Condor', 'iron_condor', [['put', true, -0.07], ['put', false, -0.035], ['call', false, 0.035], ['call', true, 0.07]]),
      P('Iron Butterfly', 'iron_butterfly', [['put', true, -0.05], ['put', false, 0], ['call', false, 0], ['call', true, 0.05]]),
      P('Call Butterfly', 'long_butterfly', [['call', true, -0.04], ['call', false, 0, { qty: 2 }], ['call', true, 0.04]]),
      P('Broken-Wing Butterfly', 'broken_wing_butterfly', [['put', true, 0.02], ['put', false, -0.02, { qty: 2 }], ['put', true, -0.08]]),
    ] },
    { label: 'Different expiries', presets: [
      P('Call Calendar', 'calendar', [['call', false, 0, { dte: 30 }], ['call', true, 0, { dte: 60, iv: 17 }]]),
      P('Double Calendar', 'double_calendar', [
        ['put', false, -0.03, { dte: 30 }], ['put', true, -0.03, { dte: 60, iv: 17 }],
        ['call', false, 0.03, { dte: 30 }], ['call', true, 0.03, { dte: 60, iv: 17 }]]),
      P('Put Diagonal', 'diagonal', [['put', false, -0.02, { dte: 21 }], ['put', true, -0.04, { dte: 63, iv: 19 }]]),
    ] },
    { label: 'Other', presets: [
      P('Call Ratio Spread', 'ratio_spread', [['call', true, 0], ['call', false, 0.05, { qty: 2 }]]),
      P('Jade Lizard', 'jade_lizard', [['put', false, -0.05], ['call', false, 0.03], ['call', true, 0.06]]),
    ] },
  ]);

  const ALL = Object.freeze(GROUPS.flatMap((g) => g.presets));
  const BY_NAME = new Map(ALL.map((p) => [p.name, p]));

  /** The legs for a preset, made with the page's own leg builder: makeLeg(kind, long, offset, options). */
  function build(name, makeLeg) {
    const p = BY_NAME.get(name);
    return p ? p.legs.map(([kind, long, offset, opts]) => makeLeg(kind, long, offset, opts || {})) : null;
  }

  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  const blank = (x) => x === null || x === undefined || x === '' || (typeof x === 'number' && !Number.isFinite(x));
  const RECENTRE_MOVE = 0.02; // the spot moved by more than 2%
  const NEAR_OLD_SPOT = 0.15; // and the strikes sat within 15% of the old spot

  /**
   * A what-if shape drawn for one spot, re-drawn for another. When a symbol loads at a spot far
   * from the one the legs were drawn around (e.g. the page's placeholder 5800 vs SPX 7688), legs
   * that are still pure hypotheticals get their strikes scaled to the new spot, keeping the shape.
   * Applies only when every leg is unlinked with a blank premium and fill (a stock leg's typed
   * entry price counts too): anything linked to the market or carrying a typed price is the user's,
   * and left alone. Strikes that already sit near the new spot (typed at real levels) are left
   * alone too, and so is a shape that rounding would fold (two legs onto one strike).
   * @returns {object[]|null} new legs, or null when nothing should change. Inputs are not changed.
   */
  function recentre(legs, prevSpot, nextSpot, roundStrike) {
    if (!Array.isArray(legs) || !finite(prevSpot) || !finite(nextSpot) || prevSpot <= 0 || nextSpot <= 0) return null;
    if (Math.abs(nextSpot / prevSpot - 1) <= RECENTRE_MOVE) return null;
    const options = legs.filter((l) => l && l.kind !== 'stock');
    if (!options.length) return null;
    const untouched = (l) => !l.live && blank(l.premium) && blank(l.fill);
    const hypothetical = legs.every((l) => !l || untouched(l))
      && options.every((l) => finite(l.strike) && l.strike > 0);
    if (!hypothetical) return null;
    const centre = options.reduce((s, l) => s + l.strike, 0) / options.length;
    if (Math.abs(centre / prevSpot - 1) > NEAR_OLD_SPOT) return null;
    const ratio = nextSpot / prevSpot;
    const out = legs.map((l) => (l && l.kind !== 'stock' ? { ...l, strike: roundStrike(l.strike * ratio) } : l));
    // Shrinking a narrow shape (e.g. SPX -> XSP) can round two different strikes onto one.
    const distinct = (list) => new Set(list.filter((l) => l && l.kind !== 'stock').map((l) => `${l.kind}|${l.strike}`)).size;
    return distinct(out) < distinct(legs) ? null : out;
  }

  return { GROUPS, ALL, build, recentre };
});
