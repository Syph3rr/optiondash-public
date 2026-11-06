'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../modules/chain/web/chain.js');

const q = (right, strike, over = {}) => ({
  right, strike, bid: 1, ask: 1.2, last: 1.1, mark: 1.1, delta: right === 'C' ? 0.5 : -0.5,
  iv: 0.2, dte: 30, source: 'ibkr', ...over,
});

test('pivot joins calls and puts by strike, sorted, without changing input', () => {
  const rows = Object.freeze([Object.freeze(q('P', 100)), Object.freeze(q('C', 105)), Object.freeze(q('C', 100))]);
  const t = C.pivot(rows);
  assert.deepEqual(t.map((r) => r.strike), [100, 105]);
  assert.ok(t[0].call && t[0].put);
  assert.ok(t[1].call && !t[1].put);
});

test('pivot ignores malformed rows', () => {
  assert.deepEqual(C.pivot([null, { right: 'C' }, { strike: 5 }]), []);
  assert.deepEqual(C.pivot(undefined), []);
});

test('atmStrike is the strike nearest spot', () => {
  const t = C.pivot([q('C', 95), q('C', 100), q('C', 105)]);
  assert.equal(C.atmStrike(t, 101.4), 100);
  assert.equal(C.atmStrike(t, 103), 105);
  assert.equal(C.atmStrike([], 100), null);
});

test('expectedMove is the ATM straddle in dollars and percent of spot', () => {
  const t = C.pivot([q('C', 100, { mark: 3 }), q('P', 100, { mark: 2.5 }), q('C', 105)]);
  const m = C.expectedMove(t, 100);
  assert.equal(m.strike, 100);
  assert.equal(m.dollars, 5.5);
  assert.equal(m.pct, 5.5);
});

test('expectedMove is null without both ATM marks', () => {
  assert.equal(C.expectedMove(C.pivot([q('C', 100)]), 100), null);
  assert.equal(C.expectedMove(C.pivot([q('C', 100, { mark: null }), q('P', 100)]), 100), null);
});

test('skew uses OTM options: puts below spot, calls at or above', () => {
  const t = C.pivot([
    q('P', 90, { iv: 0.3 }), q('C', 90, { iv: 0.9 }),
    q('P', 110, { iv: 0.9 }), q('C', 110, { iv: 0.25 }),
  ]);
  const s = C.skew(t, 100);
  assert.deepEqual(s.map((p) => [p.strike, p.iv]), [[90, 0.3], [110, 0.25]]);
});

test('skew drops strikes with no usable IV', () => {
  const t = C.pivot([q('P', 90, { iv: null }), q('C', 110, { iv: 0.25 })]);
  assert.deepEqual(C.skew(t, 100).map((p) => p.strike), [110]);
});

test('spreadPct is spread over mark, null when it cannot be known', () => {
  assert.equal(C.spreadPct(q('C', 1, { bid: 1, ask: 1.2, mark: 1.1 })), 18.18);
  assert.equal(C.spreadPct(q('C', 1, { bid: null })), null);
  assert.equal(C.spreadPct(q('C', 1, { mark: 0 })), null);
  // A crossed quote (ask below bid) is bad data, not a negative spread.
  assert.equal(C.spreadPct(q('C', 1, { bid: 0.81, ask: 0.02, mark: 0.4 })), null);
});

const rows = [
  q('C', 100, { delta: 0.5, iv: 0.2, bid: 2, ask: 2.1, mark: 2.05 }),
  q('C', 110, { delta: 0.2, iv: 0.25, bid: 0.5, ask: 0.9, mark: 0.7 }),
  q('P', 90, { delta: -0.25, iv: 0.3, bid: 0.8, ask: 0.9, mark: 0.85 }),
  q('P', 80, { delta: -0.1, iv: 0.35, bid: 0, ask: 0.3, mark: 0.15 }),
];

test('screen filters by side and absolute delta', () => {
  const out = C.screen(rows, { side: 'P', deltaMin: 0.2, deltaMax: 0.3 });
  assert.deepEqual(out.map((r) => r.strike), [90]);
  const both = C.screen(rows, { deltaMin: 0.15, deltaMax: 0.55 });
  assert.deepEqual(both.map((r) => r.strike).sort(), [100, 110, 90]);
});

test('screen filters by minimum bid, maximum spread and IV range', () => {
  assert.deepEqual(C.screen(rows, { minBid: 0.6 }).map((r) => r.strike).sort(), [100, 90]);
  assert.deepEqual(C.screen(rows, { maxSpreadPct: 12 }).map((r) => r.strike).sort(), [100, 90]);
  assert.deepEqual(C.screen(rows, { ivMin: 0.28 }).map((r) => r.strike).sort(), [80, 90]);
  assert.deepEqual(C.screen(rows, { ivMax: 0.21 }).map((r) => r.strike), [100]);
});

test('screen with no filters returns everything, sorted by the chosen key', () => {
  assert.equal(C.screen(rows, {}).length, 4);
  const byIv = C.screen(rows, {}, { key: 'iv', dir: 'desc' });
  assert.deepEqual(byIv.map((r) => r.strike), [80, 90, 110, 100]);
});

test('screen excludes a contract with a missing value the filter needs', () => {
  const r = [q('C', 100, { delta: null })];
  assert.equal(C.screen(r, { deltaMin: 0.1 }).length, 0);
  assert.equal(C.screen(r, {}).length, 1);
});

test('screen rows carry the computed spread and never mutate the input', () => {
  const frozen = Object.freeze(rows.map((x) => Object.freeze({ ...x })));
  const out = C.screen(frozen, {});
  assert.ok('spreadPct' in out[0]);
  assert.ok(!('spreadPct' in frozen[0]));
});

test('initialView opens on the chart unless a known tab is remembered', () => {
  assert.equal(C.initialView(''), 'chart');
  assert.equal(C.initialView(undefined), 'chart');
  assert.equal(C.initialView('#chain'), 'chain');
  assert.equal(C.initialView('skew'), 'skew');
  assert.equal(C.initialView('#SCREENER'), 'screener');
  assert.equal(C.initialView('#nope'), 'chart');
  assert.equal(C.VIEWS[0], 'chart');
});
