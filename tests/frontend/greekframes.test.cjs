'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../modules/analyser/web/controls.js'); // greekframes.js reads New York time from ODControls
const G = require('../../modules/analyser/web/greekframes.js');

const DAY = 86400000;
const NOW = Date.parse('2026-11-02T14:00:00Z');
const near = (got, want, tol = 1e-9) => assert.ok(Math.abs(got - want) < tol, `${got} vs ${want}`);

// ---------------------------------------------------------- frame times
test('frame times run evenly from From to To, both ends exact', () => {
  const t = G.frameTimes(2, 30);
  assert.equal(t.length, G.FRAMES);
  assert.equal(G.FRAMES, 40);
  assert.equal(t[0], 2);
  assert.equal(t[t.length - 1], 30);
  const steps = t.slice(1).map((v, i) => v - t[i]);
  steps.forEach((s) => near(s, 28 / 39));
});

test('frame times can be asked for in another count', () => {
  assert.deepEqual(G.frameTimes(0, 1, 3), [0, 0.5, 1]);
});

// ---------------------------------------------------------- index lookup
test('each frame time is found in the reply times, or -1 when the engine left it out', () => {
  const times = [0, 0.5, 1, 1.25, 2, 3];
  assert.deepEqual(G.frameIndexes(times, [0.5, 1.25, 3]), [1, 3, 5]);
  assert.deepEqual(G.frameIndexes(times, [1.2500000001, 2.7]), [3, -1]);
});

// ---------------------------------------------------------- y ranges
test('a y range covers every series with a little padding', () => {
  const [lo, hi] = G.yRange([[0, 5, 10], [-10, 2]]);
  near(lo, -10 - 20 * 0.06);
  near(hi, 10 + 20 * 0.06);
});

test('a y range skips gaps and opens up a flat line', () => {
  assert.deepEqual(G.yRange([[null, NaN, 4, 4]]), [3.6, 4.4]);
  const [lo, hi] = G.yRange([[0, 0]]);
  assert.ok(lo < 0 && hi > 0);
  assert.equal(G.yRange([[null], []]), null);
});

test('price ranges are fixed per greek over all frames', () => {
  const frames = [
    { byPrice: { delta: [1, 2], gamma: [0, 0.1] } },
    { byPrice: { delta: [3, -4], gamma: [0.2, 0] } },
  ];
  const r = G.priceRanges(frames, ['delta', 'gamma']);
  assert.ok(r.delta[0] < -4 && r.delta[1] > 3);
  assert.ok(r.gamma[0] < 0 && r.gamma[1] > 0.2);
});

// ---------------------------------------------------------- reply → frames
test('a frame reads one time row of every greek, its value at spot, and its instant', () => {
  const row = (base) => [base, base + 1, base + 2];
  const reply = {
    times: [0, 1], prices: [90, 100, 110], spot_index: 1,
    grid: { delta: [row(0), row(10)], gamma: [row(20), row(30)] },
  };
  const f = G.frameAt(reply, 1, ['delta', 'gamma'], NOW);
  assert.equal(f.t, 1);
  assert.equal(f.ms, NOW + DAY);
  assert.deepEqual(f.x, [90, 100, 110]);
  assert.deepEqual(f.byPrice.delta, [10, 11, 12]);
  assert.deepEqual(f.atSpot, { delta: 11, gamma: 31 });
});

test('a curve over time takes in the frame points, sorted, the frame winning a tie', () => {
  const c = G.mergeCurve([0, 1, 2], [10, 11, 12], [0.5, 1, 1.5], [99, 98, 97]);
  assert.deepEqual(c.x, [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(c.y, [10, 99, 98, 97, 12]);
});

// ---------------------------------------------------------- From / To
// NOW is Monday 2 Nov, 09:00 New York; the first expiry settles Friday 6 Nov, 16:00
const FRI_1600 = 4 + 7 / 24;
test('blank From and To mean now and the close the day before a 16:00 first expiry', () => {
  const s = G.playSpan({ from: null, to: null }, NOW, FRI_1600, 30);
  assert.equal(s.ok, true);
  assert.equal(s.fromMs, NOW);
  assert.equal(s.toMs, Date.parse('2026-11-05T21:00:00Z')); // Thu 16:00 New York
  assert.equal(s.from, 0);
  near(s.to, 3 + 7 / 24);
});

test('a picked From and To are read as days from now, kept inside the trade', () => {
  const s = G.playSpan({ from: NOW + 2 * DAY, to: NOW + 90 * DAY }, NOW, 7, 30);
  assert.deepEqual(s, { ok: true, from: 2, to: 30, fromMs: NOW + 2 * DAY, toMs: NOW + 30 * DAY });
});

test('From at or after To disables play with a reason', () => {
  const s = G.playSpan({ from: NOW + 9 * DAY, to: null }, NOW, FRI_1600, 30);
  assert.equal(s.ok, false);
  assert.match(s.reason, /From must be before To/);
  assert.equal(G.playSpan({ from: null, to: null }, NOW, undefined, 0).ok, false);
});

test('a pick near now on From means now; a past To or one past the last expiry is refused', () => {
  const sel = { from: null, to: null };
  assert.deepEqual(G.applyPick(sel, 'from', NOW + 30000, NOW, 30), { sel, error: '' });
  const later = G.applyPick(sel, 'from', NOW + DAY, NOW, 30);
  assert.deepEqual(later.sel, { from: NOW + DAY, to: null });
  assert.notEqual(later.sel, sel); // a new object, never the old one changed
  assert.match(G.applyPick(sel, 'to', NOW - DAY, NOW, 30).error, /after now/);
  assert.match(G.applyPick(sel, 'to', NOW + 31 * DAY, NOW, 30).error, /last expiry/);
  assert.match(G.applyPick(sel, 'to', NaN, NOW, 30).error, /date and time/);
  assert.equal(G.applyPick(sel, 'to', NOW - DAY, NOW, 30).sel, sel);
});

test('a stored From or To that has gone stale is dropped back to its default', () => {
  const sel = { from: NOW - DAY, to: NOW + 40 * DAY };
  assert.deepEqual(G.cleanSel(sel, NOW, 30), { from: null, to: null });
  const ok = { from: NOW + DAY, to: NOW + 5 * DAY };
  assert.equal(G.cleanSel(ok, NOW, 30), ok); // unchanged: the same object back
  assert.deepEqual(G.cleanSel(undefined, NOW, 30), { from: null, to: null });
  assert.deepEqual(G.cleanSel({ from: 'x', to: {} }, NOW, 30), { from: null, to: null });
});

// ---------------------------------------------------------- cache key
const body = (o = {}) => ({
  spot: 5800.12, rate: 0.04, div_yield: 0.013, model: 'european', iv_shift: 0, range: 0.0812345,
  n_prices: 121, n_dates: 2, at_days: [],
  legs: [{ kind: 'call', long: true, qty: 1, strike: 5800, dte: 30, iv: 0.18, premium: null, multiplier: 100, enabled: true }],
  ...o,
});

test('the frame key ignores Live-sized ticks but follows real changes', () => {
  const sel = { from: null, to: null };
  const k = G.frameKey(body(), sel);
  assert.equal(G.frameKey(body({ spot: 5800.3, range: 0.0812399, at_days: [1, 2] }), sel), k);
  assert.notEqual(G.frameKey(body({ spot: 5830 }), sel), k);
  assert.notEqual(G.frameKey(body({ iv_shift: 0.01 }), sel), k);
  const legs = [{ ...body().legs[0], strike: 5850 }];
  assert.notEqual(G.frameKey(body({ legs }), sel), k);
});

test('the frame key holds picked From and To to the minute, as instants, not days from now', () => {
  const pick = { from: NOW + DAY, to: NOW + 5 * DAY };
  const k = G.frameKey(body(), pick);
  assert.equal(G.frameKey(body(), { from: NOW + DAY + 20000, to: NOW + 5 * DAY - 20000 }), k);
  assert.notEqual(G.frameKey(body(), { ...pick, to: NOW + 5 * DAY + 120000 }), k);
  assert.notEqual(G.frameKey(body(), { ...pick, from: null }), k);
});

// ---------------------------------------------------------- playback clock
test('playback picks the frame for the time played, ending on the last', () => {
  assert.equal(G.frameAtElapsed(0, 40, 4000), 0);
  assert.equal(G.frameAtElapsed(2000, 40, 4000), 19);
  assert.equal(G.frameAtElapsed(4000, 40, 4000), 39);
  assert.equal(G.frameAtElapsed(9000, 40, 4000), 39);
  assert.equal(G.frameAtElapsed(-5, 40, 4000), 0);
});

// ---------------------------------------------------------- default To
const ny = (iso) => Date.parse(iso); // November 2026 is EST: New York = UTC-5
test('default To is the close the day before a 16:00 settlement', () => {
  assert.equal(G.defaultToMs(ny('2026-11-20T21:00:00Z'), NOW), ny('2026-11-19T21:00:00Z')); // Fri → Thu 16:00
  assert.equal(G.defaultToMs(ny('2026-11-16T21:00:00Z'), NOW), ny('2026-11-13T21:00:00Z')); // Mon → Fri 16:00
});

test('an expiry worked out in fractional days still counts as its own day', () => {
  assert.equal(G.defaultToMs(ny('2026-11-20T21:00:00Z') - 1, NOW), ny('2026-11-19T21:00:00Z'));
});

test('default To for a 09:30 AM settlement is 16:00 the trading day before', () => {
  assert.equal(G.defaultToMs(ny('2026-11-20T14:30:00Z'), NOW), ny('2026-11-19T21:00:00Z')); // Fri → Thu
  assert.equal(G.defaultToMs(ny('2026-11-16T14:30:00Z'), NOW), ny('2026-11-13T21:00:00Z')); // Mon → Fri
});

test('an expiry at another time of day also ends at the close the day before', () => {
  assert.equal(G.defaultToMs(ny('2026-11-20T19:00:00Z'), NOW), ny('2026-11-19T21:00:00Z')); // 14:00 Fri → Thu 16:00
});

test('default To falls back to half an hour before expiry, then the expiry, when From is later', () => {
  const am = ny('2026-11-20T14:30:00Z'); // Fri 09:30
  assert.equal(G.defaultToMs(am, ny('2026-11-19T22:00:00Z')), ny('2026-11-20T14:00:00Z')); // From Thu 17:00
  const pm = ny('2026-11-20T21:00:00Z'); // Fri 16:00
  assert.equal(G.defaultToMs(pm, ny('2026-11-20T15:00:00Z')), ny('2026-11-20T20:30:00Z')); // From Fri 10:00
  assert.equal(G.defaultToMs(pm, ny('2026-11-20T20:45:00Z')), pm); // From 15:45
});
