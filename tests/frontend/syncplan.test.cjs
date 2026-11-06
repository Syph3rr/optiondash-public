'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../modules/analyser/web/legrules.js'); // syncplan.js reads window.ODRules, as in the page
const P = require('../../modules/analyser/web/syncplan.js');

const EXP = { expiry: '20261120', trading_class: 'SPXW', dte: 18 };
const LISTED = [{ expiry: 'E18', trading_class: 'SPXW', dte: 18 }, { expiry: 'E33', trading_class: 'SPXW', dte: 33 }];
const STRIKES = [90, 95, 100, 105, 110];

const contract = (o = {}) => ({
  symbol: 'SPX', expiry: '20261120', strike: 7580, right: 'C', trading_class: 'SPXW', ...o,
});
const quote = (o = {}) => ({
  ...contract(), multiplier: 100, dte: 9.5, bid: 1, ask: 2, last: 1.5, mark: 1.5, mark_kind: 'mid',
  delta: 0.5, iv: 0.18, iv_source: 'solved', source: 'ibkr', data_type: 'delayed', ...o,
});
const manual = (o = {}) => ({
  id: 1, enabled: true, kind: 'call', long: true, qty: 1, strike: 7580, dte: 18, iv: 16,
  premium: null, multiplier: 100, ivOverride: false, ...o,
});
/** A leg already linked to a contract, as a chain pick or an earlier Sync leaves it. */
const linked = (strike, dte, expiry, o = {}) => manual({
  strike, dte, premium: 5, ...o,
  live: contract({ strike, expiry, right: (o.kind || 'call') === 'put' ? 'P' : 'C' }),
});

const plan = (legs, listed = LISTED, strikes = STRIKES) => {
  const open = P.planSync(legs, listed);
  const groups = open.groups.map((g) => ({ ...g, strikes }));
  return { snaps: P.planContracts(legs, groups, 'SPX'), unmatched: open.unmatched };
};

/** What Sync would do to each leg: `strike@expiry`, a miss, or 'linked' if it was left alone. */
function outcomes(legs, listed = LISTED, strikes = STRIKES) {
  const { snaps } = plan(legs, listed, strikes);
  return legs.map((l) => {
    const s = snaps.find((x) => x.leg === l);
    if (!s) return 'linked';
    return s.miss || `${s.contract.strike}@${s.contract.expiry}`;
  });
}

/** One full Sync, every contract priced. @returns {object[]} the legs afterwards */
function syncOnce(legs, listed = LISTED, strikes = STRIKES) {
  const { snaps } = plan(legs, listed, strikes);
  const dteOf = (c) => listed.find((e) => e.expiry === c.expiry).dte;
  const quotes = P.snapContracts(snaps).map((c) => quote({ ...c, dte: dteOf(c), mark: 2 }));
  const results = new Map(P.resolveSnaps(snaps, quotes, legs).map((r) => [r.leg, r]));
  return legs.map((l) => (results.has(l) && results.get(l).next) || l);
}

const key = (c) => [c.expiry, c.strike, c.right, c.trading_class].join('|');
/** Pairs of legs that differed at the start and now sit on one contract. */
function collapsedPairs(before, after) {
  const pairs = [];
  after.forEach((a, i) => after.forEach((b, j) => {
    if (j <= i || !a.live || !b.live || key(a.live) !== key(b.live)) return;
    if (before[i].strike !== before[j].strike || before[i].dte !== before[j].dte) pairs.push([i, j]);
  }));
  return pairs;
}

// ---------------------------------------------------------- the one rule
const put = (o) => manual({ kind: 'put', ...o });
const REFUSED = [
  ['nearer strike keeps it', [manual({ strike: 100 }), manual({ strike: 101 })],
    ['100@E18', 'collapse'], [100, 105]],
  ['order does not matter', [manual({ strike: 101 }), manual({ strike: 100 })],
    ['collapse', '100@E18'], [100, 105]],
  ['an equal strike tie refuses both', [manual({ strike: 99 }), manual({ strike: 101 })],
    ['collapse', 'collapse'], [100]],
  ['nearer DTE keeps a shared expiry', [manual({ strike: 100, dte: 30 }), manual({ strike: 100, dte: 37 })],
    ['100@E33', 'collapse']],
  ['later DTE keeps it when nearer', [manual({ strike: 100, dte: 35 }), manual({ strike: 100, dte: 28 })],
    ['100@E33', 'collapse']],
  ['an equal DTE tie refuses both', [manual({ strike: 100, dte: 31 }), manual({ strike: 100, dte: 35 })],
    ['collapse', 'collapse']],
  ['a strike gap outranks a DTE gap', [manual({ strike: 100, dte: 40 }), manual({ strike: 101, dte: 33 })],
    ['100@E33', 'collapse']],
  ['three legs, one contract', [manual({ strike: 100 }), manual({ strike: 101 }), manual({ strike: 102 })],
    ['100@E18', 'collapse', 'collapse'], [100]],
  ['puts are held to it too', [put({ strike: 100 }), put({ strike: 101 })],
    ['100@E18', 'collapse'], [100, 105]],
  ['a linked leg holds its strike', [linked(100, 18, 'E18'), manual({ strike: 101 })],
    ['linked', 'collapse'], [100, 105]],
  ['a linked leg wins even when the other is exact', [linked(100, 18, 'E18'), manual({ strike: 100, dte: 16 })],
    ['linked', 'collapse']],
  ['a linked leg holds its expiry', [linked(100, 33, 'E33'), manual({ strike: 100, dte: 37 })],
    ['linked', 'collapse']],
  ['a disabled linked leg still holds it', [linked(100, 18, 'E18', { enabled: false }), manual({ strike: 101 })],
    ['linked', 'collapse'], [100, 105]],
];
REFUSED.forEach(([name, legs, want, strikes]) => {
  test(`refused: ${name}`, () => assert.deepEqual(outcomes(legs, LISTED, strikes), want));
});

const KEPT = [
  ['a straddle shares a strike', [put({ strike: 100 }), manual({ strike: 100 })],
    ['100@E18', '100@E18']],
  ['a straddle snapped together', [put({ strike: 101 }), manual({ strike: 101 })],
    ['100@E18', '100@E18']],
  ['a strangle may meet at one strike', [put({ strike: 99 }), manual({ strike: 101 })],
    ['100@E18', '100@E18'], [100]],
  ['identical legs stay together', [manual({ strike: 101 }), manual({ strike: 101 })],
    ['100@E18', '100@E18']],
  ['identical legs beat a third together', [manual({ strike: 100 }), manual({ strike: 100 }), manual({ strike: 101 })],
    ['100@E18', '100@E18', 'collapse'], [100]],
  ['a calendar on separate expiries', [manual({ strike: 100, dte: 18 }), manual({ strike: 100, dte: 33 })],
    ['100@E18', '100@E33']],
  ['a calendar with inexact DTEs', [manual({ strike: 100, dte: 16 }), manual({ strike: 100, dte: 35 })],
    ['100@E18', '100@E33']],
  ['a diagonal on separate expiries', [put({ strike: 95, dte: 18 }), put({ strike: 105, dte: 33 })],
    ['95@E18', '105@E33']],
  ['different strikes may share an expiry', [manual({ strike: 100, dte: 30 }), manual({ strike: 105, dte: 37 })],
    ['100@E33', '105@E33']],
  ['a vertical stays a vertical', [manual({ strike: 100 }), manual({ strike: 105 })],
    ['100@E18', '105@E18']],
  ['a linked leg identical to the manual one', [linked(100, 18, 'E18'), manual({ strike: 100, dte: 18 })],
    ['linked', '100@E18']],
  ['a linked call does not hold the put', [linked(100, 18, 'E18'), put({ strike: 101 })],
    ['linked', '100@E18']],
  ['a linked leg on another expiry holds nothing here', [linked(100, 33, 'E33'), manual({ strike: 100, dte: 18 })],
    ['linked', '100@E18']],
];
KEPT.forEach(([name, legs, want, strikes]) => {
  test(`kept: ${name}`, () => assert.deepEqual(outcomes(legs, LISTED, strikes), want));
});

test('a linked leg in another trading class holds nothing here', () => {
  const held = manual({ strike: 100, premium: 5, live: contract({ strike: 100, expiry: 'E18', trading_class: 'SPX' }) });
  assert.deepEqual(outcomes([held, manual({ strike: 101 })]), ['linked', '100@E18']);
});

// ---------------------------------------------------------- repeated Sync
const REPEATED = [
  ['two strikes, one listed', [manual({ strike: 100 }), manual({ strike: 101, long: false })], LISTED, [100, 105]],
  ['a chain pick and a manual leg', [linked(100, 18, 'E18'), manual({ strike: 101 })], LISTED, [100, 105]],
  ['a calendar with one expiry', [manual({ strike: 100, dte: 30 }), manual({ strike: 100, dte: 37 })], LISTED, STRIKES],
  ['an exact tie', [manual({ strike: 99 }), manual({ strike: 101 })], LISTED, [100]],
];
REPEATED.forEach(([name, legs, listed, strikes]) => {
  test(`repeated Sync stays refused: ${name}`, () => {
    const once = syncOnce(legs, listed, strikes);
    const twice = syncOnce(once, listed, strikes);
    const thrice = syncOnce(twice, listed, strikes);
    assert.deepEqual(collapsedPairs(legs, thrice), []);
    assert.deepEqual(twice.map((l) => !!l.live), once.map((l) => !!l.live));
    assert.deepEqual(thrice.map((l) => l.strike), once.map((l) => l.strike));
  });
});

test('the finding: BUY 100 and SELL 101 do not net to nothing on the second press', () => {
  const legs = [manual({ strike: 100, long: true }), manual({ strike: 101, long: false })];
  const twice = syncOnce(syncOnce(legs, LISTED, [100, 105]), LISTED, [100, 105]);
  assert.equal(twice[0].strike, 100);
  assert.ok(twice[0].live);
  assert.equal(twice[1].strike, 101);
  assert.ok(!twice[1].live);
  const { snaps } = plan(twice, LISTED, [100, 105]);
  assert.equal(P.syncSummary(0, snaps, ''),
    "0 linked, 1 left unlinked: 1 would land on another leg's contract");
});

test('no two different legs ever share a contract, across seeded random positions', () => {
  let seed = 12345;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const listed = [{ expiry: 'A', trading_class: 'X', dte: 7 }, { expiry: 'B', trading_class: 'X', dte: 30 },
    { expiry: 'C', trading_class: 'X', dte: 60 }];
  for (let round = 0; round < 500; round += 1) {
    const legs = Array.from({ length: 2 + next(5) }, (_, i) => manual({
      id: i, kind: next(2) ? 'call' : 'put', strike: 96 + next(9), dte: 5 + next(60) }));
    const after = syncOnce(syncOnce(legs, listed, [95, 100, 105]), listed, [95, 100, 105]);
    assert.deepEqual(collapsedPairs(legs, after), [], JSON.stringify(legs.map((l) => [l.kind, l.strike, l.dte])));
  }
});

// ---------------------------------------------------------- expiries
test('nearest expiry goes by DTE and skips what has expired', () => {
  const list = [{ expiry: 'a', dte: -0.1 }, { expiry: 'b', dte: 0 }, { expiry: 'c', dte: 7 },
    { expiry: 'd', dte: 30 }, { expiry: 'e', dte: 60 }];
  assert.equal(P.nearestExpiry(list, 28).expiry, 'd');
  assert.equal(P.nearestExpiry(list, 0).expiry, 'c');
  assert.equal(P.nearestExpiry(list, 400).expiry, 'e');
});

test('nearest expiry takes the earlier on a tie and null when none is listed', () => {
  assert.equal(P.nearestExpiry([{ expiry: 'a', dte: 10 }, { expiry: 'b', dte: 20 }], 15).expiry, 'a');
  assert.equal(P.nearestExpiry([], 15), null);
  assert.equal(P.nearestExpiry([{ expiry: 'a', dte: 0 }], 15), null);
});

test('sync plans one strikes request per expiry and right', () => {
  const expiries = [{ expiry: '20261120', trading_class: 'SPXW', dte: 18 },
    { expiry: '20261218', trading_class: 'SPX', dte: 46 }];
  const legs = [manual({ id: 1, dte: 20 }), manual({ id: 2, dte: 16 }), put({ id: 3, dte: 17 }),
    manual({ id: 4, dte: 50 })];
  const out = P.planSync(legs, expiries);
  assert.deepEqual(out.groups.map((g) => [g.expiry.expiry, g.right, g.picks.map((p) => p.leg.id)]),
    [['20261120', 'C', [1, 2]], ['20261120', 'P', [3]], ['20261218', 'C', [4]]]);
  assert.deepEqual(out.unmatched, []);
});

test('sync never plans a linked or stock leg, and reports legs with no expiry', () => {
  const legs = [linked(100, 18, 'E18'), manual({ id: 2, kind: 'stock' }), manual({ id: 3 })];
  const { groups } = P.planSync(legs, [{ expiry: 'a', trading_class: 'X', dte: 9 }]);
  assert.deepEqual(groups[0].picks.map((p) => p.leg.id), [3]);
  const none = P.planSync(legs, []);
  assert.equal(none.groups.length, 0);
  assert.deepEqual(none.unmatched.map((l) => l.id), [3]);
});

// ---------------------------------------------------------- strikes
const snapOne = (o, strikes = STRIKES) => plan([manual(o)], LISTED, strikes).snaps[0];

test('a leg snaps to the nearest real strike', () => {
  assert.equal(snapOne({ strike: 101 }).contract.strike, 100);
  assert.equal(snapOne({ strike: 103 }).contract.strike, 105);
  assert.equal(snapOne({ strike: 100 }).contract.strike, 100);
});

test('a snap records the leg as it was', () => {
  assert.deepEqual(snapOne({ strike: 101, dte: 19 }).from, { strike: 101, dte: 19, kind: 'call', listed: null });
});

test('exactly 5% away links; further stays unlinked and names the nearest strike', () => {
  assert.equal(snapOne({ strike: 100 }, [105]).contract.strike, 105);
  assert.equal(snapOne({ strike: 100 }, [95]).contract.strike, 95);
  const far = snapOne({ strike: 100 }, [105.01]);
  assert.equal(far.miss, 'too_far');
  assert.equal(far.nearest, 105.01);
  assert.equal(far.contract, undefined);
});

test('no listed strike is a miss, and a failed lookup says so', () => {
  assert.equal(snapOne({}, []).miss, 'no_contract');
  assert.equal(snapOne({}, null).miss, 'failed');
});

test('a condor far from spot keeps four strikes (the window bug)', () => {
  const listed = Array.from({ length: 300 }, (_, i) => 500 + i);
  const legs = [[640, 'put'], [705, 'put'], [800, 'call'], [760, 'call']]
    .map(([strike, kind]) => manual({ strike, kind }));
  const { snaps } = plan(legs, LISTED, listed);
  assert.deepEqual(snaps.map((s) => s.contract.strike).sort((a, b) => a - b), [640, 705, 760, 799]);
});

test('strike lists are checked before use', () => {
  assert.deepEqual(P.validStrikes([100, '105', -1, 0, null, NaN, 110]), [100, 110]);
  assert.deepEqual(P.validStrikes('nope'), []);
  assert.deepEqual(P.validStrikes(undefined), []);
});

// ---------------------------------------------------------- contracts and quotes
const group = (legs, strikes = [7580, 7600], expiries = [EXP]) => P.planSync(legs, expiries)
  .groups.map((g) => ({ ...g, strikes }));

test('contracts for quoting: right from the kind, each contract once, misses left out', () => {
  const legs = [put({ id: 1 }), put({ id: 2 }), manual({ id: 3, strike: 7600 }), manual({ id: 4, strike: 1 })];
  assert.deepEqual(P.snapContracts(P.planContracts(legs, group(legs), 'SPX')), [
    contract({ right: 'P' }), contract({ strike: 7600 }),
  ]);
});

const snapped = (o = {}) => P.planContracts([manual({ strike: 7581, ...o })],
  group([manual({ strike: 7581, ...o })]), 'SPX')[0];
const resolve = (s, quotes) => P.resolveSnaps([s], quotes, [s.leg])[0];

test('a blank-premium leg links with a mark, taking strike, IV and premium', () => {
  const out = resolve(snapped(), [quote({ mark: 3.5, iv: 0.2 })]);
  assert.equal(out.miss, undefined);
  assert.equal(out.next.strike, 7580);
  assert.equal(out.next.premium, 3.5);
  assert.equal(out.next.iv, 20);
  assert.ok(out.next.live);
});

test('a blank-premium leg with no mark stays unlinked: no price available', () => {
  const out = resolve(snapped(), [quote({ mark: null, iv: null })]);
  assert.equal(out.miss, 'no_price');
  assert.equal(out.next, undefined);
});

// Market closed: Yahoo has no bid or ask, so the sidecar's mark is the last trade (mark_kind 'last').
const closed = (o = {}) => quote({ bid: null, ask: null, last: 4.09, mark: 4.09, mark_kind: 'last', ...o });

test('with the market closed a blank premium links from the last trade, and says so', () => {
  const out = resolve(snapped(), [closed()]);
  assert.equal(out.miss, undefined);
  assert.equal(out.next.premium, 4.09);
  assert.ok(out.next.live);
  assert.equal(out.markKind, 'last');
});

test('a premium from a live mid is marked as a mid', () => {
  assert.equal(resolve(snapped(), [quote({ mark: 3.5 })]).markKind, 'mid');
});

test('a typed premium is not priced by Sync, so it carries no price kind', () => {
  const out = resolve(snapped({ premium: 7 }), [closed()]);
  assert.equal(out.next.premium, 7);
  assert.equal(out.markKind, undefined);
});

test('a typed-premium leg links to its exact nearest strike even with no mark', () => {
  const out = resolve(snapped({ premium: 7 }), [quote({ mark: null, iv: null })]);
  assert.equal(out.miss, undefined);
  assert.equal(out.next.strike, 7580);
  assert.equal(out.next.premium, 7);
  assert.ok(out.next.live);
});

test('a typed premium and IV survive linking', () => {
  const out = resolve(snapped({ premium: 7, iv: 33, ivOverride: true }), [quote({ mark: 3 })]);
  assert.equal(out.next.premium, 7);
  assert.equal(out.next.iv, 33);
  assert.equal(out.next.ivOverride, true);
});

test('a leg links only to the quote for its own contract', () => {
  const out = resolve(snapped(), [quote({ strike: 7600 }), quote({ right: 'P' })]);
  assert.equal(out.miss, 'no_price');
  const asPut = resolve(snapped({ kind: 'put' }), [quote(), quote({ right: 'P', mark: 9 })]);
  assert.equal(asPut.next.premium, 9);
});

test('an expired quote leaves the leg unlinked', () => {
  assert.equal(resolve(snapped({ premium: 7 }), [quote({ dte: 0 })]).miss, 'no_contract');
});

const EDITS = [['strike', { strike: 7000 }], ['DTE', { dte: 3 }], ['type', { kind: 'put' }]];
EDITS.forEach(([name, edit]) => {
  test(`a ${name} typed while Sync was out wins over the snap`, () => {
    const s = snapped({ premium: 7 });
    assert.equal(resolve({ ...s, leg: { ...s.leg, ...edit } }, [quote()]).miss, 'edited');
  });
});

test('an edit made while strikes are being fetched is still caught', () => {
  const leg = manual({ strike: 7581, dte: 18, premium: 7 });
  const { groups } = P.planSync([leg], [EXP]);
  const typed = { ...leg, dte: 44 };
  const later = groups.map((g) => ({ ...g, strikes: [7580],
    picks: g.picks.map((p) => ({ ...p, leg: typed })) }));
  const [snap] = P.planContracts([typed], later, 'SPX');
  assert.equal(snap.from.dte, 18);
  assert.equal(P.resolveSnaps([snap], [quote()], [typed])[0].miss, 'edited');
});

test('earlier misses pass through resolve', () => {
  const s = { leg: manual(), miss: 'too_far' };
  assert.deepEqual(P.resolveSnaps([s], [], [s.leg]), [s]);
});

test('unpriced finds contracts with no mark, which get the one retry', () => {
  const a = contract();
  const b = contract({ strike: 7600 });
  const c = contract({ strike: 7700 });
  const out = P.unpriced([a, b, c], [quote(), quote({ strike: 7600, mark: null })]);
  assert.deepEqual(out, [b, c]);
  assert.deepEqual(P.unpriced([a], [quote()]), []);
});

test('a retry only replaces a quote when it found a mark', () => {
  const first = [quote({ mark: 1 }), quote({ strike: 7600, mark: null })];
  const retry = [quote({ strike: 7600, mark: 2 }), quote({ mark: null })];
  const out = P.mergeQuotes(first, retry);
  assert.equal(out.length, 2);
  assert.equal(out.find((q) => q.strike === 7580).mark, 1);
  assert.equal(out.find((q) => q.strike === 7600).mark, 2);
  assert.equal(P.mergeQuotes([quote({ mark: null })], [quote({ mark: null })]).length, 1);
});

// ---------------------------------------------------------- a chain pick during Sync
test('a chain pick made during the quote wait is seen just before linking', () => {
  const open = manual({ strike: 101, premium: 7 });
  const { snaps } = plan([open], LISTED, [100, 105]);
  const picked = linked(100, 18, 'E18');
  const [out] = P.resolveSnaps(snaps, [quote({ ...snaps[0].contract })], [open, picked]);
  assert.equal(out.miss, 'collapse');
  assert.equal(out.next, undefined);
});

test('a chain pick on another contract does not stop the link', () => {
  const open = manual({ strike: 101, premium: 7 });
  const { snaps } = plan([open], LISTED, [100, 105]);
  const picked = linked(105, 18, 'E18');
  const [out] = P.resolveSnaps(snaps, [quote({ ...snaps[0].contract })], [open, picked]);
  assert.equal(out.next.live.strike, 100);
});

// ---------------------------------------------------------- blank premiums on linked legs
const blankLinked = (o = {}) => linked(7580, 18, '20261120', { premium: null, iv: 16, ...o });
const refill = (leg, quotes, legs = [leg]) => {
  const [snap] = P.planContracts([leg], [], 'SPX');
  return P.resolveSnaps([snap], quotes, legs)[0];
};

[null, undefined, ''].forEach((premium) => {
  test(`a linked leg with premium ${JSON.stringify(premium)} is filled from its own contract`, () => {
    const leg = blankLinked({ premium });
    assert.deepEqual(P.snapContracts(P.planContracts([leg], [], 'SPX')), [leg.live]);
    const out = refill(leg, [quote({ mark: 3.5, iv: 0.5, dte: 9.5, multiplier: 50 })]);
    assert.deepEqual(out.next, { ...leg, premium: 3.5 });
  });
});

test('no expiries are needed to fill a linked leg', () => {
  const leg = blankLinked();
  const open = P.planSync([leg], []);
  assert.deepEqual(open, { groups: [], unmatched: [] });
  assert.equal(P.planContracts([leg], open.groups, 'SPX').length, 1);
});

test('a linked leg with a premium is not touched, zero included', () => {
  assert.deepEqual(P.planContracts([linked(7580, 18, '20261120')], [], 'SPX'), []);
  assert.deepEqual(P.planContracts([blankLinked({ premium: 0 })], [], 'SPX'), []);
});

test("a linked leg of another symbol is not Sync's to fill", () => {
  const leg = { ...blankLinked(), live: contract({ symbol: 'NDX' }) };
  assert.deepEqual(P.planContracts([leg], [], 'SPX'), []);
});

test('only the quote for that exact contract fills it', () => {
  const out = refill(blankLinked(), [quote({ strike: 7600, mark: 9 }), quote({ right: 'P', mark: 9 })]);
  assert.equal(out.miss, 'no_price');
  assert.equal(out.next, undefined);
});

test('with no mark the leg stays as it was, linked and blank', () => {
  const out = refill(blankLinked(), [quote({ mark: null })]);
  assert.equal(out.miss, 'no_price');
  assert.equal(out.next, undefined);
  assert.equal(out.refill, true);
});

test('a blank premium filled from the last trade says so', () => {
  const out = refill(blankLinked(), [quote({ bid: null, ask: null, mark: 4.09, mark_kind: 'last' })]);
  assert.equal(out.next.premium, 4.09);
  assert.equal(out.markKind, 'last');
});

test('an expired quote fills nothing', () => {
  assert.equal(refill(blankLinked(), [quote({ dte: 0, mark: 3 })]).miss, 'no_price');
});

test('a premium typed during the wait is kept', () => {
  const leg = blankLinked();
  const [snap] = P.planContracts([leg], [], 'SPX');
  const typed = { ...snap, leg: { ...leg, premium: 7 } };
  const out = P.resolveSnaps([typed], [quote({ mark: 3 })], [typed.leg])[0];
  assert.equal(out.next, undefined);
  assert.equal(out.miss, undefined);
});

test('a leg unlinked during the wait is left alone', () => {
  const leg = blankLinked();
  const [snap] = P.planContracts([leg], [], 'SPX');
  const unlinked = { ...snap, leg: { ...leg, live: null } };
  assert.equal(P.resolveSnaps([unlinked], [quote()], [unlinked.leg])[0].miss, 'edited');
});

test('a poll moving DTE during the wait does not stop the fill', () => {
  const leg = blankLinked();
  const [snap] = P.planContracts([leg], [], 'SPX');
  const polled = { ...snap, leg: { ...leg, dte: 17.99 } };
  const out = P.resolveSnaps([polled], [quote({ mark: 3 })], [polled.leg])[0];
  assert.deepEqual(out.next, { ...polled.leg, premium: 3 });
});

test('a fill neither claims a contract nor loses one', () => {
  const held = linked(100, 18, 'E18', { premium: null });
  const same = linked(100, 25, 'E18', { premium: null });
  const open = manual({ strike: 101 });
  assert.deepEqual(outcomes([held, same, open], LISTED, [100, 105]),
    ['100@E18', '100@E18', 'collapse']);
});

test('tally counts fills apart from links', () => {
  const results = [{ leg: 1, next: {} }, { leg: 2, miss: 'no_price' },
    { leg: 3, refill: true, next: {} }, { leg: 4, refill: true, miss: 'no_price' }, { leg: 5, refill: true }];
  const lost = { leg: 6, miss: 'no_contract' };
  assert.deepEqual(P.tally(results, [lost]),
    { linked: 1, filled: 1, unfilled: 1, fromLast: 0, misses: [lost, results[1]] });
});

test('tally counts premiums that came from a last trade, linked or filled', () => {
  const results = [{ leg: 1, next: {}, markKind: 'last' }, { leg: 2, next: {}, markKind: 'mid' },
    { leg: 3, refill: true, next: {}, markKind: 'last' }, { leg: 4, next: {} }];
  assert.equal(P.tally(results, []).fromLast, 2);
});

// ---------------------------------------------------------- summary
const SUMMARIES = [
  ['nothing to do', 0, [], '', 'no unlinked option legs'],
  ['all linked', 4, [], '', '4 linked to market'],
  ['a count per reason', 2, [{ miss: 'no_price' }, { miss: 'no_price' }, { miss: 'collapse' }], '',
    "2 linked, 3 left unlinked: 2 no price available, 1 would land on another leg's contract"],
  ['the rest of the reasons', 0, [{ miss: 'no_contract' }, { miss: 'edited' }], '',
    '0 linked, 2 left unlinked: 1 no matching contract, 1 edited during sync'],
  ['a failure in its own words', 1, [{ miss: 'failed' }, { miss: 'no_price' }], 'server not reachable',
    '1 linked, 2 left unlinked: 1 no price available, server not reachable'],
  ['the nearest strike for a refused leg', 0,
    [{ miss: 'too_far', from: { strike: 650 }, nearest: 703 }], '',
    '0 linked, 1 left unlinked: 1 over 5% from a listed strike (650: nearest 703)'],
  ['the nearest strike for each refused leg', 1,
    [{ miss: 'too_far', from: { strike: 650 }, nearest: 703 },
      { miss: 'too_far', from: { strike: 900 }, nearest: 809 }], '',
    '1 linked, 2 left unlinked: 2 over 5% from a listed strike (650: nearest 703, 900: nearest 809)'],
];
SUMMARIES.forEach(([name, linkedCount, misses, failure, want]) => {
  test(`sync summary: ${name}`, () => assert.equal(P.syncSummary(linkedCount, misses, failure), want));
});

const FILL_SUMMARIES = [
  ['only fills', 0, [], '', 1, 0, '1 premium filled'],
  ['links and fills', 2, [], '', 2, 0, '2 linked to market, 2 premiums filled'],
  ['a fill with no price', 0, [], '', 0, 1, '1 blank premium not filled'],
  ['a failed fill says why', 0, [], 'server not reachable', 0, 2,
    '2 blank premiums not filled, server not reachable'],
  ['beside a miss', 1, [{ miss: 'no_price' }], '', 1, 1,
    '1 linked, 1 left unlinked: 1 no price available, 1 premium filled, 1 blank premium not filled'],
];
FILL_SUMMARIES.forEach(([name, linkedCount, misses, failure, filled, unfilled, want]) => {
  test(`sync summary: ${name}`, () =>
    assert.equal(P.syncSummary(linkedCount, misses, failure, filled, unfilled), want));
});

// A last trade can be hours old, so it must never read as a live price.
const LAST_SUMMARIES = [
  ['all from the last trade', 4, [], '', 0, 0, 4,
    '4 linked to market, 4 premiums from the last trade (no live bid/ask)'],
  ['one fill from the last trade', 0, [], '', 1, 0, 1,
    '1 premium filled, 1 premium from the last trade (no live bid/ask)'],
  ['a last trade beside a miss', 1, [{ miss: 'too_far', from: { strike: 600 }, nearest: 690 }], '', 0, 0, 1,
    '1 linked, 1 left unlinked: 1 over 5% from a listed strike (600: nearest 690), '
    + '1 premium from the last trade (no live bid/ask)'],
];
LAST_SUMMARIES.forEach(([name, linkedCount, misses, failure, filled, unfilled, fromLast, want]) => {
  test(`sync summary: ${name}`, () =>
    assert.equal(P.syncSummary(linkedCount, misses, failure, filled, unfilled, fromLast), want));
});

test('helpers never change their inputs', () => {
  const legs = Object.freeze([Object.freeze(linked(7580, 18, 'E18')), Object.freeze(manual({ id: 2, strike: 7581 }))]);
  const quotes = Object.freeze([Object.freeze(quote({ iv: 0.5 }))]);
  assert.doesNotThrow(() => {
    P.planSync(legs, [{ expiry: 'a', trading_class: 'X', dte: 1 }]);
    const snaps = Object.freeze(P.planContracts(legs, group([legs[1]], [7580]), 'SPX')
      .map((s) => Object.freeze(s)));
    P.snapContracts(snaps);
    P.resolveSnaps(snaps, quotes, legs);
    P.unpriced([contract()], quotes);
    P.mergeQuotes(quotes, quotes);
  });
});

// ---------------------------------------------------------- expiry chosen by date
// AAPL from Sydney on 3 Nov: IBKR calls 6 Nov "3 days", but it settles 4.26 days away.
const AAPL = [{ expiry: '20261104', trading_class: 'AAPL', dte: 2.26 },
  { expiry: '20261106', trading_class: 'AAPL', dte: 4.26 }];
const listedOn = (expiry) => ({ symbol: 'AAPL', expiry, trading_class: 'AAPL' });

test('a leg with a date picked syncs to that date, however far its DTE has drifted', () => {
  const legs = [manual({ dte: 3.3, listed: listedOn('20261106') }),
    manual({ id: 2, dte: 0.5, listed: listedOn('20261106') })];
  const { groups } = P.planSync(legs, AAPL);
  assert.deepEqual(groups.map((g) => g.expiry.expiry), ['20261106']);
  assert.equal(groups[0].picks.length, 2);
});

test('a picked date that is no longer listed falls back to the nearest DTE', () => {
  const { groups } = P.planSync([manual({ dte: 2.4, listed: listedOn('20261105') })], AAPL);
  assert.equal(groups[0].expiry.expiry, '20261104');
});

test('legs on the same picked date stay together even when their DTEs were aged apart', () => {
  const on = (expiry) => ({ symbol: 'SPX', expiry, trading_class: 'SPXW' });
  const held = linked(100, 18.00001, 'E18', { listed: on('E18') });
  const fresh = manual({ id: 2, strike: 100, dte: 18, listed: on('E18') });
  assert.deepEqual(outcomes([held, fresh]), ['linked', '100@E18']);
  const twoPicked = [manual({ strike: 100, dte: 18.00002, listed: on('E18') }),
    manual({ id: 2, strike: 100, dte: 18, listed: on('E18') })];
  assert.deepEqual(outcomes(twoPicked), ['100@E18', '100@E18']);
});
