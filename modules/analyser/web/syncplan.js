// Pure planning for Sync to market: which real contract each leg should link to, and why not.
// Loaded in the browser as window.ODSync and in Node tests through module.exports.
(function (root) {
  'use strict';
  const R = root.ODRules;
  const MAX_CONTRACTS = 32;
  const MAX_SNAP = 0.05;  // a leg stays unlinked rather than move further than this
  const EPS = 1e-9;
  const RIGHTS = new Map([['call', 'C'], ['put', 'P']]);
  const MISS_TEXT = new Map([['too_far', 'over 5% from a listed strike'],
    ['no_contract', 'no matching contract'], ['no_price', 'no price available'],
    ['collapse', "would land on another leg's contract"], ['edited', 'edited during sync']]);

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const contractKey = (c) => [c.symbol, c.expiry, c.strike, c.right, c.trading_class].join('|');
  const nearestBy = (items, value, of) => items.reduce((best, x) =>
    (best === null || Math.abs(of(x) - value) < Math.abs(of(best) - value) ? x : best), null);

  const validStrikes = (list) => (Array.isArray(list) ? list.filter((k) => num(k) && k > 0) : []);

  /** @returns {object|null} the listed expiry nearest a DTE; expired ones are never chosen */
  const nearestExpiry = (expiries, dte) => nearestBy(expiries.filter((e) => e.dte > 0), dte, (e) => e.dte);

  /** @returns {object|null} the date picked for the leg while it is still listed, else the nearest */
  const expiryFor = (leg, expiries) => (leg.listed && expiries.find((e) => e.dte > 0
    && e.expiry === leg.listed.expiry && e.trading_class === leg.listed.trading_class))
    || nearestExpiry(expiries, leg.dte);

  /**
   * Groups unlinked option legs by expiry (the date picked, else the nearest DTE) and right, so each list is fetched once. `from`
   * is taken here, when the expiry is chosen, so anything typed after this point is seen as an edit.
   */
  function planSync(legs, expiries) {
    const groups = new Map();
    const unmatched = [];
    legs.filter((l) => !l.live && RIGHTS.has(l.kind)).forEach((l) => {
      const expiry = expiryFor(l, expiries);
      if (!expiry) { unmatched.push(l); return; }
      const right = RIGHTS.get(l.kind);
      const key = `${expiry.expiry}|${expiry.trading_class}|${right}`;
      const group = groups.get(key) || { expiry, right, picks: [] };
      const from = { strike: l.strike, dte: l.dte, kind: l.kind, listed: l.listed || null };
      groups.set(key, { ...group, picks: [...group.picks, { leg: l, from }] });
    });
    return { groups: [...groups.values()], unmatched };
  }

  function snapLeg({ leg, from }, { expiry, right, strikes }, symbol) {
    if (strikes === null) return { leg, from, miss: 'failed' };
    const strike = nearestBy(strikes, from.strike, (k) => k);
    if (strike === null) return { leg, from, miss: 'no_contract' };
    const gap = Math.abs(strike - from.strike);
    if (gap > MAX_SNAP * from.strike + EPS) return { leg, from, miss: 'too_far', nearest: strike };
    return { leg, from, gap: [gap, Math.abs(expiry.dte - from.dte)],
      contract: { symbol, expiry: expiry.expiry, strike, right, trading_class: expiry.trading_class } };
  }

  /** A leg's expiry date when it has one: its contract's, else the date picked for it. */
  const dayOf = (from) => {
    const c = from.live || from.listed;
    return c ? `${c.expiry}|${c.trading_class}` : null;
  };
  /** Two legs on the same date are on the same expiry, whatever moment their DTEs were aged at. */
  const sameExpiry = (a, b) => {
    const [x, y] = [dayOf(a.from), dayOf(b.from)];
    return x && y ? x === y : a.from.dte === b.from.dte;
  };
  const differed = (a, b) => a.from.strike !== b.from.strike || !sameExpiry(a, b);
  const atLeastAsNear = (a, b) => a.gap[0] < b.gap[0] || (a.gap[0] === b.gap[0] && a.gap[1] <= b.gap[1]);
  const sameContract = (a, b) => contractKey(a.contract) === contractKey(b.contract);

  /**
   * The one rule: Sync never puts two legs that were different on the same contract, or a spread
   * or calendar silently nets to nothing. Different means another strike or DTE before Sync, so
   * identical legs stay together, and the contract includes the right, so a straddle is fine.
   * A linked leg always holds its contract (gap below any snap), which is what makes a repeated
   * Sync safe. The nearer leg keeps a contested contract, by strike and then by DTE; a tie
   * refuses both. A linked leg being filled moves nowhere, so it claims nothing new.
   */
  function keepContractsApart(snaps, legs) {
    const held = legs.filter((l) => l.live).map((l) => ({ from: l, contract: l.live, gap: [-1, -1] }));
    const claims = [...held, ...snaps.filter((s) => !s.miss && !s.refill)];
    const loses = (s) => claims.some((c) => sameContract(c, s) && differed(c, s) && atLeastAsNear(c, s));
    return snaps.map((s) => (s.miss || s.refill || !loses(s) ? s : { leg: s.leg, from: s.from, miss: 'collapse' }));
  }

  /**
   * Linked legs with a blank premium. Clearing the box leaves a leg linked, and the engine then
   * re-bases it to theoretical on every refresh, so its P&L reads zero until a price goes back in.
   */
  const blankPremiums = (legs, symbol) => legs
    .filter((l) => l.live && l.live.symbol === symbol && R.blank(l.premium))
    .map((leg) => ({ leg, contract: leg.live, refill: true }));

  /**
   * Every open leg's target, given all legs (linked ones included) and groups that carry their
   * listed strikes (null when the lookup failed), then the linked legs that need a premium.
   * @returns {{leg: object, from?: object, contract?: object, miss?: string, nearest?: number, refill?: boolean}[]}
   */
  function planContracts(legs, groups, symbol) {
    const snaps = groups.flatMap((g) => g.picks.map((p) => snapLeg(p, g, symbol)));
    return [...keepContractsApart(snaps, legs), ...blankPremiums(legs, symbol)];
  }

  /** @returns {object[]} the contracts to quote: each once, up to the route limit */
  function snapContracts(snaps) {
    const wanted = snaps.filter((s) => !s.miss).map((s) => s.contract);
    return [...new Map(wanted.map((c) => [contractKey(c), c])).values()].slice(0, MAX_CONTRACTS);
  }

  function linkSnap(s, q) {
    const { leg, from } = s;
    if (leg.strike !== from.strike || leg.dte !== from.dte || leg.kind !== from.kind) {
      return { leg, miss: 'edited' };
    }
    // Premium is the current price and fill is my entry price. Older set-ups typed the entry
    // price into premium; the first Market fetch after Manual promotes it to fill. Sync leaves a typed premium
    // alone, so only a blank one needs the market's mark.
    if (!q || (R.blank(leg.premium) && !num(q.mark))) return { leg, miss: 'no_price' };
    const next = R.syncLeg(leg, q);
    if (!next.live) return { leg, miss: 'no_contract' };
    return R.blank(leg.premium) ? { leg, next, markKind: q.mark_kind } : { leg, next };
  }

  /** Only the premium changes: the leg keeps its contract, DTE and IV. */
  function fillSnap({ leg, contract }, q) {
    const done = { leg, refill: true };
    if (!leg.live || contractKey(leg.live) !== contractKey(contract)) return { ...done, miss: 'edited' };
    if (!R.blank(leg.premium)) return done;
    const usable = q && num(q.mark) && !(num(q.dte) && q.dte <= 0);
    return usable ? { ...done, next: { ...leg, premium: q.mark }, markKind: q.mark_kind }
      : { ...done, miss: 'no_price' };
  }

  /**
   * Each snap's outcome, given quotes and the legs as they stand now: a chain pick during the wait
   * for quotes can hold a contract a snap was heading for, so the one rule runs again here.
   * @returns {{leg: object, next?: object, miss?: string, refill?: boolean}[]}
   */
  function resolveSnaps(snaps, quotes, legs) {
    const byContract = new Map(quotes.map((q) => [contractKey(q), q]));
    const resolveOne = (s) => (s.refill ? fillSnap : linkSnap)(s, byContract.get(contractKey(s.contract)));
    return keepContractsApart(snaps, legs).map((s) => (s.miss ? s : resolveOne(s)));
  }

  /**
   * fromLast counts premiums Sync took from a last trade: with the market closed there is no bid
   * or ask, so the sidecar's mark is the last trade, which can be hours old and must say so.
   * @returns {{linked: number, filled: number, unfilled: number, fromLast: number, misses: object[]}}
   */
  function tally(results, unmatched) {
    const moved = results.filter((r) => !r.refill);
    const fills = results.filter((r) => r.refill);
    return { linked: moved.filter((r) => r.next).length, filled: fills.filter((r) => r.next).length,
      unfilled: fills.filter((r) => r.miss).length,
      fromLast: results.filter((r) => r.next && r.markKind === 'last').length,
      misses: [...unmatched, ...moved.filter((r) => r.miss)] };
  }

  /** @returns {object[]} the contracts that have no mark yet */
  function unpriced(contracts, quotes) {
    const marked = new Set(quotes.filter((q) => num(q.mark)).map(contractKey));
    return contracts.filter((c) => !marked.has(contractKey(c)));
  }

  /** @returns {object[]} the first quotes, improved by any retry quote that found a mark */
  function mergeQuotes(first, retry) {
    const merged = new Map(first.map((q) => [contractKey(q), q]));
    retry.filter((q) => num(q.mark) || !merged.has(contractKey(q)))
      .forEach((q) => merged.set(contractKey(q), q));
    return [...merged.values()];
  }

  /** @param {{miss: string, from?: object, nearest?: number}[]} misses the legs left unlinked */
  function syncSummary(linked, misses, failure, filled = 0, unfilled = 0, fromLast = 0) {
    const count = (n, one, many) => (n ? [`${n} ${n > 1 ? many : one}`] : []);
    const notes = [...count(filled, 'premium filled', 'premiums filled'),
      ...count(unfilled, 'blank premium not filled', 'blank premiums not filled'),
      ...count(fromLast, 'premium from the last trade (no live bid/ask)',
        'premiums from the last trade (no live bid/ask)')];
    if (!misses.length) {
      const done = [...(linked ? [`${linked} linked to market`] : []), ...notes];
      if (!done.length) return 'no unlinked option legs';
      return [...done, ...(unfilled && failure ? [failure] : [])].join(', ');
    }
    const reason = ([miss, words]) => {
      const legs = misses.filter((m) => m.miss === miss);
      const named = legs.filter((m) => m.nearest !== undefined)
        .map((m) => `${m.from.strike}: nearest ${m.nearest}`);
      return legs.length ? [`${legs.length} ${words}${named.length ? ` (${named.join(', ')})` : ''}`] : [];
    };
    const reasons = [...MISS_TEXT].flatMap(reason);
    return `${linked} linked, ${misses.length} left unlinked: ${[...reasons, ...notes, ...(failure ? [failure] : [])].join(', ')}`;
  }

  const api = {
    MAX_CONTRACTS, num, contractKey, nearestBy, validStrikes, nearestExpiry, planSync, planContracts,
    snapContracts, resolveSnaps, tally, unpriced, mergeQuotes, syncSummary,
  };
  root.ODSync = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
