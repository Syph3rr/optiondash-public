// Forward IV between legs on different expiries. Display only: pricing never uses it.
// Loaded in the browser as window.ODForward and in Node tests through module.exports.
// IV is a percent and time is calendar days, as in the legs. Every function returns new objects.
(function (root) {
  'use strict';
  const { dteText } = root.ODControls || require('./controls.js');
  const MIN_IV = 0.5;           // percent; the engine's floor, so shown IVs are the priced ones
  const DTE_EPS = 1e-6;         // legs this close in DTE share an expiry
  const MIN_VARIANCE = 1e-6;    // below this there is no forward vol to speak of
  const LETTER = { call: 'C', put: 'P' };

  /** @returns {number|null} forward IV in percent; null when total variance does not rise */
  function forwardIv(ivFront, dteFront, ivBack, dteBack) {
    const gap = dteBack - dteFront;
    const variance = (ivBack * ivBack * dteBack - ivFront * ivFront * dteFront) / gap;
    return gap > DTE_EPS && variance > MIN_VARIANCE ? Math.sqrt(variance) : null;
  }

  const usable = (l) => l.enabled && l.kind !== 'stock' && l.qty > 0 && l.dte > 0;
  const sameExpiry = (a, b) => Math.abs(a.dte - b.dte) <= DTE_EPS;
  const sameContract = (a, b) => a.kind === b.kind && a.strike === b.strike;

  /** @returns {object[][]} legs sorted by DTE, grouped into one list per expiry */
  function byExpiry(legs) {
    return legs.reduce((groups, l) => {
      const last = groups[groups.length - 1];
      return last && sameExpiry(last[0], l)
        ? [...groups.slice(0, -1), [...last, l]]
        : [...groups, [l]];
    }, []);
  }

  /** @returns {object[]} one leg from each expiry, a bought and a sold one when there are both */
  function acrossExpiries(front, back) {
    const first = front.find((a) => back.some((b) => a.long !== b.long)) || front[0];
    return [first, back.find((b) => first.long !== b.long) || back[0]];
  }

  /** Neighbouring expiries on one type and strike, whichever side the legs are on. */
  function calendarPairs(legs) {
    const groups = new Map();
    [...legs].sort((a, b) => a.dte - b.dte).forEach((l) => {
      const key = `${l.kind}|${l.strike}`;
      groups.set(key, [...(groups.get(key) || []), l]);
    });
    return [...groups.values()].flatMap((group) => {
      const expiries = byExpiry(group);
      return expiries.slice(1).map((back, i) => acrossExpiries(expiries[i], back));
    });
  }

  /**
   * Legs left over on different expiries. Each leg is used once, matched by type,
   * then opposite side, then nearest strike, then nearest expiry.
   */
  function crossPairs(legs) {
    const candidates = legs.flatMap((a, i) => legs.slice(i + 1)
      .filter((b) => !sameExpiry(a, b) && !sameContract(a, b))
      .map((b) => [a, b]));
    const distance = ([a, b]) => [
      a.kind === b.kind ? 0 : 1, a.long !== b.long ? 0 : 1,
      Math.abs(a.strike - b.strike), Math.abs(a.dte - b.dte),
    ];
    const sorted = [...candidates].sort((x, y) => {
      const dy = distance(y);
      return distance(x).reduce((order, d, i) => order || d - dy[i], 0);
    });
    return sorted.reduce((taken, pair) => {
      const used = taken.flat();
      return pair.some((l) => used.includes(l)) ? taken : [...taken, pair];
    }, []);
  }

  function toPair(a, b, ivShift) {
    const [first, second] = a.dte < b.dte ? [a, b] : [b, a];
    const side = (l) => ({
      kind: l.kind, strike: l.strike, dte: l.dte, iv: Math.max(l.iv + ivShift, MIN_IV),
    });
    const front = side(first);
    const back = side(second);
    return {
      kind: first.kind, front, back, gap: back.dte - front.dte,
      mixed: front.kind !== back.kind,
      diagonal: front.kind === back.kind && front.strike !== back.strike,
      forward: forwardIv(front.iv, front.dte, back.iv, back.dte),
    };
  }

  /**
   * @param {object[]} legs the dashboard's legs
   * @param {number} ivShift parallel shift in vol points
   * @returns {object[]} one pair per calendar, then one per other pair across expiries
   */
  function forwardPairs(legs, ivShift) {
    const open = legs.filter(usable);
    const calendars = calendarPairs(open);
    const paired = calendars.flat();
    const others = crossPairs(open.filter((l) => !paired.includes(l)));
    return [...calendars, ...others].map(([a, b]) => toPair(a, b, ivShift));
  }

  function line(pair) {
    const { diagonal, mixed, front, back, gap, forward } = pair;
    const name = (s) => `${s.strike}${LETTER[s.kind]}`;
    const iv = (s) => `${dteText(s.dte)}d ${s.iv.toFixed(1)}%`;
    const backName = diagonal || mixed ? `${name(back)} ` : '';
    const legs = `${name(front)} ${iv(front)} → ${backName}${iv(back)}`;
    if (forward === null) return `${legs} | Inverted: no forward IV`;
    const tag = (diagonal ? ' · diagonal' : '') + (mixed ? ' · call/put' : '');
    return `${legs} | Forward ${forward.toFixed(1)}% (${dteText(gap)}d)${tag}`;
  }

  /** @returns {string[]} one line per pair */
  const forwardLines = (legs, ivShift) => forwardPairs(legs, ivShift).map(line);

  /** Fills el with the lines, and hides it when the legs share one expiry. */
  function render(el, legs, ivShift) {
    const lines = forwardLines(legs, ivShift);
    el.hidden = !lines.length;
    el.textContent = lines.join('\n');
  }

  const api = { forwardIv, forwardPairs, forwardLines, render };
  root.ODForward = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
