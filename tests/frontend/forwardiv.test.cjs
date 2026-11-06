// Run with: node --test "tests/frontend/*.test.cjs"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../../modules/analyser/web/forwardiv.js');

const leg = (over) => ({
  kind: 'call', long: true, qty: 1, strike: 100, dte: 30, iv: 20, enabled: true, ...over,
});
const short = (over) => leg({ long: false, ...over });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

test('forwardIv matches a worked example', () => {
  near(f.forwardIv(16, 30, 18, 60), Math.sqrt((18 * 18 * 60 - 16 * 16 * 30) / 30));
  assert.equal(f.forwardIv(16, 30, 18, 60).toFixed(1), '19.8');
});

test('a flat term structure has a forward equal to itself', () => {
  near(f.forwardIv(20, 30, 20, 60), 20);
});

test('forwardIv is null when total variance falls with time', () => {
  assert.equal(f.forwardIv(20, 30, 12, 60), null);
});

test('forwardIv is null when total variance is exactly flat', () => {
  assert.equal(f.forwardIv(20, 30, Math.sqrt(200), 60), null);
});

test('a calendar pairs front and back whichever order the legs are in', () => {
  const [pair] = f.forwardPairs([leg({ dte: 60, iv: 18 }), short({ dte: 30, iv: 16 })], 0);
  assert.equal(pair.front.dte, 30);
  assert.equal(pair.back.dte, 60);
  assert.equal(pair.gap, 30);
  assert.equal(pair.diagonal, false);
  assert.equal(pair.forward.toFixed(1), '19.8');
});

test('a long front and short back is still a calendar', () => {
  const pairs = f.forwardPairs([leg({ dte: 30 }), short({ dte: 60 })], 0);
  assert.equal(pairs.length, 1);
});

test('any two option legs on different expiries give a forward', () => {
  const cases = {
    'sell then buy': [short({ dte: 30 }), leg({ dte: 60 })],
    'two buys': [leg({ dte: 30 }), leg({ dte: 60 })],
    'two sells': [short({ dte: 30 }), short({ dte: 60 })],
    'call against put': [short({ dte: 30 }), leg({ dte: 60, kind: 'put' })],
    'different strikes, same side': [leg({ dte: 30 }), leg({ dte: 60, strike: 110 })],
    'put against call, different strikes': [leg({ dte: 30, kind: 'put', strike: 90 }), leg({ dte: 60, strike: 110 })],
  };
  Object.entries(cases).forEach(([name, legs]) => assert.equal(f.forwardPairs(legs, 0).length, 1, name));
});

test('two buys on one strike read as a plain calendar', () => {
  assert.deepEqual(f.forwardLines([leg({ dte: 30 }), leg({ dte: 60 })], 0),
    ['100C 30d 20.0% → 60d 20.0% | Forward 20.0% (30d)']);
});

test('a call against a put names both legs and says so', () => {
  assert.deepEqual(f.forwardLines([short({ dte: 30 }), leg({ dte: 60, kind: 'put' })], 0),
    ['100C 30d 20.0% → 100P 60d 20.0% | Forward 20.0% (30d) · call/put']);
});

test('leftover legs pair with the opposite side before a nearer strike', () => {
  const pairs = f.forwardPairs([
    short({ strike: 100, dte: 30 }), short({ strike: 102, dte: 60 }), leg({ strike: 105, dte: 60 }),
  ], 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].back.strike, 105);
});

test('leftover legs pair within a type before crossing to the other', () => {
  const pairs = f.forwardPairs([
    short({ strike: 100, dte: 30 }), leg({ strike: 100, dte: 60, kind: 'put' }), leg({ strike: 110, dte: 60 }),
  ], 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].back.strike, 110);
  assert.equal(pairs[0].diagonal, true);
});

test('legs with no second expiry give nothing', () => {
  const cases = {
    'same expiry': [short({ dte: 30 }), leg({ dte: 30 })],
    'stock leg': [short({ dte: 30 }), leg({ dte: 60, kind: 'stock' })],
    'unticked leg': [short({ dte: 30 }), leg({ dte: 60, enabled: false })],
    'zero quantity': [short({ dte: 30, qty: 0 }), leg({ dte: 60 })],
    'expired leg': [short({ dte: 0 }), leg({ dte: 60 })],
    'single leg': [leg({})],
    'no legs': [],
  };
  Object.entries(cases).forEach(([name, legs]) => assert.deepEqual(f.forwardPairs(legs, 0), [], name));
});

test('a double calendar gives one pair per strike and type', () => {
  const pairs = f.forwardPairs([
    short({ kind: 'put', strike: 95, dte: 30 }), leg({ kind: 'put', strike: 95, dte: 60 }),
    short({ strike: 105, dte: 30 }), leg({ strike: 105, dte: 60 }),
  ], 0);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => p.kind).sort(), ['call', 'put']);
  assert.ok(pairs.every((p) => !p.diagonal));
});

test('three expiries on one strike give each neighbouring pair', () => {
  const pairs = f.forwardPairs([
    leg({ dte: 30, iv: 16 }), short({ dte: 60, iv: 18 }), leg({ dte: 90, iv: 19 }),
  ], 0);
  assert.deepEqual(pairs.map((p) => [p.front.dte, p.back.dte]), [[30, 60], [60, 90]]);
});

test('a repeated expiry does not hide an exact calendar', () => {
  const pairs = f.forwardPairs([short({ dte: 30 }), leg({ dte: 30 }), leg({ dte: 60 })], 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].diagonal, false);
  assert.deepEqual([pairs[0].front.dte, pairs[0].back.dte], [30, 60]);
});

test('leftover legs on one strike are never called a diagonal', () => {
  const pairs = f.forwardPairs([
    short({ dte: 30 }), leg({ dte: 30 }), short({ dte: 60 }), leg({ dte: 60 }),
  ], 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].diagonal, false);
});

test('a diagonal is paired and tagged, with both strikes kept', () => {
  const [pair] = f.forwardPairs([short({ strike: 105, dte: 30 }), leg({ strike: 110, dte: 60 })], 0);
  assert.equal(pair.diagonal, true);
  assert.equal(pair.front.strike, 105);
  assert.equal(pair.back.strike, 110);
});

test('an exact calendar keeps its legs away from a diagonal', () => {
  const pairs = f.forwardPairs([
    short({ strike: 100, dte: 30 }), leg({ strike: 100, dte: 60 }), leg({ strike: 110, dte: 60 }),
  ], 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].diagonal, false);
});

test('a diagonal takes the nearest strike, and each leg is used once', () => {
  const pairs = f.forwardPairs([
    short({ strike: 100, dte: 30 }), leg({ strike: 120, dte: 60 }), leg({ strike: 105, dte: 60 }),
  ], 0);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].back.strike, 105);
});

test('the IV shift and the engine floor both apply', () => {
  const [pair] = f.forwardPairs([short({ dte: 30, iv: 16 }), leg({ dte: 60, iv: 18 })], 2);
  assert.equal(pair.front.iv, 18);
  assert.equal(pair.back.iv, 20);
  const [floored] = f.forwardPairs([short({ dte: 30, iv: 1 }), leg({ dte: 60, iv: 18 })], -5);
  assert.equal(floored.front.iv, 0.5);
});

test('a calendar line reads front, back and forward', () => {
  assert.deepEqual(f.forwardLines([short({ strike: 5800, dte: 30, iv: 16 }), leg({ strike: 5800, dte: 60, iv: 18 })], 0),
    ['5800C 30d 16.0% → 60d 18.0% | Forward 19.8% (30d)']);
});

test('a diagonal line names both strikes and carries the tag', () => {
  assert.deepEqual(f.forwardLines([
    short({ kind: 'put', strike: 95, dte: 21, iv: 18 }), leg({ kind: 'put', strike: 90, dte: 63, iv: 19 }),
  ], 0), ['95P 21d 18.0% → 90P 63d 19.0% | Forward 19.5% (42d) · diagonal']);
});

test('an inverted calendar says so instead of showing a number', () => {
  assert.deepEqual(f.forwardLines([short({ dte: 30, iv: 20 }), leg({ dte: 60, iv: 12 })], 0),
    ['100C 30d 20.0% → 60d 12.0% | Inverted: no forward IV']);
});

test('render shows the lines, and hides itself with no calendar', () => {
  const el = { hidden: true, textContent: '' };
  f.render(el, [short({ dte: 30 }), leg({ dte: 60 })], 0);
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /Forward 20\.0%/);
  f.render(el, [leg({})], 0);
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, '');
});

test('nothing changes its inputs', () => {
  const legs = [short({ dte: 60, iv: 18 }), leg({ dte: 30, iv: 16 })];
  const before = structuredClone(legs);
  f.forwardLines(Object.freeze(legs.map(Object.freeze)), 1);
  assert.deepEqual(legs, before);
});
