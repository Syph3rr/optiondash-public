'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../modules/analyser/web/controls.js'); // earnings.js reads New York time from window.ODControls
const E = require('../../modules/analyser/web/earnings.js');

const near = (got, want, tol = 1e-6) => assert.ok(Math.abs(got - want) < tol, `${got} vs ${want}`);
const leg = (o = {}) => Object.freeze({
  id: 1, enabled: true, kind: 'call', long: false, qty: 1, strike: 100, dte: 4, iv: 60,
  premium: null, multiplier: 100, ...o,
});
// A calendar priced for a report one day out: 60% front at 4 days, 40% back at 18 days.
const front = leg({ id: 1, dte: 4, iv: 60 });
const back = leg({ id: 2, long: true, dte: 18, iv: 40 });
const BASE = Math.sqrt((0.16 * 18 - 0.36 * 4) / 14);      // forward vol, 32.07%
const EVENT_VAR = (0.36 - BASE * BASE) * 4 / 365;           // variance the report adds

// ---------------------------------------------------------- timing
const AT_0900_NY = Date.parse('2026-11-02T14:00:00Z'); // Monday 2 Nov, 09:00 New York

test('after the close: the report lands at 16:00 and "after" is 10:00 the next weekday', () => {
  const t = E.eventTimes('2026-11-03', 'amc', AT_0900_NY);
  near(t.eventDays, 1 + 7 / 24);
  near(t.afterDays, 2 + 1 / 24);
  const friday = E.eventTimes('2026-11-06', 'amc', AT_0900_NY);
  near(friday.afterDays, 7 + 1 / 24); // Monday 9 Nov
});

test('before the open: the report lands at 09:30 and "after" is 10:00 the same day', () => {
  const t = E.eventTimes('2026-11-05', 'bmo', AT_0900_NY);
  near(t.eventDays, 3 + 0.5 / 24);
  near(t.afterDays, 3 + 1 / 24);
});

test('an unknown timing is taken as after the close; a bad or past date gives nothing', () => {
  near(E.eventTimes('2026-11-03', null, AT_0900_NY).eventDays, 1 + 7 / 24);
  assert.equal(E.eventTimes('3 Nov', 'amc', AT_0900_NY), null);
  assert.equal(E.eventTimes('2026-10-30', 'amc', AT_0900_NY), null);
});

// ---------------------------------------------------------- the model
test('normal vol is the forward vol across the report, and the rest of the front is the event', () => {
  const m = E.eventModel([front, back], 1);
  assert.equal(m.ok, true);
  near(m.baseIv, BASE * 100);
  near(m.eventVar, EVENT_VAR);
  near(m.move, Math.sqrt(EVENT_VAR) * 100); // about 5.3%
  assert.deepEqual([m.front.dte, m.back.dte], [4, 18]);
});

test('after the report both legs fall to normal vol: the front by far more', () => {
  const m = E.eventModel([front, back], 1);
  near(E.ivAfter(front, m, 1), BASE * 100, 1e-9);
  near(E.ivAfter(back, m, 1), BASE * 100, 1e-9);
  assert.ok(60 - E.ivAfter(front, m, 1) > 3 * (40 - E.ivAfter(back, m, 1)));
});

test('a leg that expires before the report, and a stock leg, keep their IV', () => {
  const m = E.eventModel([front, back], 1);
  assert.equal(E.ivAfter(leg({ dte: 0.5, iv: 80 }), m, 1), 80);
  assert.equal(E.ivAfter(leg({ kind: 'stock', iv: 0 }), m, 1), 0);
});

test('legs on one expiry pool their variance; legs before the report are not expiries for it', () => {
  const skewed = [front, leg({ id: 3, dte: 4, iv: 70, strike: 95 }), back,
    leg({ id: 4, dte: 0.5, iv: 90 })];
  const m = E.eventModel(skewed, 1);
  near(m.front.iv, Math.sqrt((60 * 60 + 70 * 70) / 2));
  assert.equal(m.front.dte, 4);
});

test('the model needs two expiries after the report, and says why when it cannot run', () => {
  assert.deepEqual(E.eventModel([front], 1), { ok: false, reason: 'needs legs on two expiries after the report' });
  const off = leg({ id: 2, dte: 18, iv: 40, enabled: false });
  assert.equal(E.eventModel([front, off], 1).ok, false);
  const inverted = E.eventModel([leg({ dte: 4, iv: 30 }), leg({ id: 2, dte: 18, iv: 10 })], 1);
  assert.deepEqual(inverted, { ok: false, reason: 'the back expiry has less total variance than the front' });
});

test('a front priced at or under normal vol has no earnings premium, so nothing is crushed', () => {
  const flat = E.eventModel([leg({ dte: 4, iv: 30 }), leg({ id: 2, dte: 18, iv: 40 })], 1);
  assert.equal(flat.ok, true);
  assert.equal(flat.eventVar, 0);
  assert.equal(E.ivAfter(leg({ dte: 4, iv: 30 }), flat, 1), 30);
  assert.match(flat.note, /no earnings premium/);
});

// ---------------------------------------------------------- legs for pricing
test('after-report legs: the model IV unless typed, and blank premiums pinned to today\'s entry', () => {
  const m = E.eventModel([front, back], 1);
  const typed = { ...back, ivAfter: 35 };
  const out = E.afterLegs([front, typed], m, 1, [4.1, 6.2]);
  near(out[0].iv, BASE * 100, 1e-9);
  assert.equal(out[1].iv, 35);
  assert.deepEqual(out.map((l) => l.premium), [4.1, 6.2]);
  const kept = E.afterLegs([{ ...front, premium: 3.5 }], m, 1, [4.1]);
  assert.equal(kept[0].premium, 3.5);
});

test('with no model, a typed IV after is still used and the rest stay as they are', () => {
  const none = { ok: false, reason: 'x' };
  const out = E.afterLegs([{ ...front, ivAfter: 40 }, back], none, 1, [1, 2]);
  assert.deepEqual(out.map((l) => l.iv), [40, 40]);
});

test('a frame blends variance between today and after the report', () => {
  const from = [front, back];
  const to = [{ ...front, iv: 30 }, { ...back, iv: 30 }];
  assert.deepEqual(E.frameLegs(from, to, 0).map((l) => l.iv), [60, 40]);
  assert.deepEqual(E.frameLegs(from, to, 1).map((l) => l.iv), [30, 30]);
  near(E.frameLegs(from, to, 0.5)[0].iv, Math.sqrt((3600 + 900) / 2));
});

test('the model never changes its inputs', () => {
  const legs = Object.freeze([front, back]);
  assert.doesNotThrow(() => {
    const m = E.eventModel(legs, 1);
    E.afterLegs(legs, m, 1, Object.freeze([1, 2]));
    E.frameLegs(legs, legs, 0.5);
  });
});

// ---------------------------------------------------------- panel helpers
const Panel = require('../../modules/analyser/web/earnpanel.js');

test('P&L at a price reads between the curve\'s points, and nothing off the axis', () => {
  const xs = [90, 100, 110];
  const ys = [-50, 100, 0];
  assert.equal(Panel.pnlAt(xs, ys, 100), 100);
  assert.equal(Panel.pnlAt(xs, ys, 95), 25);
  assert.equal(Panel.pnlAt(xs, ys, 90), -50);
  assert.equal(Panel.pnlAt(xs, ys, 111), null);
  assert.equal(Panel.pnlAt([], [], 100), null);
});

test('leg labels and nearest times', () => {
  assert.equal(Panel.legLabel({ long: false, qty: 2, strike: 270, kind: 'call' }), 'SELL 2 × 270C');
  assert.equal(Panel.legLabel({ long: true, qty: 1, strike: 95.5, kind: 'put' }), 'BUY 1 × 95.5P');
  assert.equal(Panel.nearestIndex([0, 1, 2.04, 4], 2.0416), 2);
});

test('frames survive Live\'s small ticks but not a real change', () => {
  const body = (o = {}) => ({ spot: 340.9151, rate: 0.04, at_days: [1.123456], range: 0.16, model: 'american',
    legs: [{ kind: 'call', strike: 340, dte: 4.23456, iv: 0.53612, premium: 8.1 }], ...o });
  const key = Panel.frameKey([body()]);
  assert.equal(Panel.frameKey([body({ spot: 340.9349 })]), key);
  assert.notEqual(Panel.frameKey([body({ spot: 342 })]), key);
  assert.notEqual(Panel.frameKey([body({ legs: [{ kind: 'call', strike: 345, dte: 4.23456, iv: 0.53612, premium: 8.1 }] })]), key);
  assert.notEqual(Panel.frameKey([body({ legs: [{ kind: 'call', strike: 340, dte: 4.23456, iv: 0.55, premium: 8.1 }] })]), key);
});

test('an expiry at the moment of the report does not carry it, even priced a moment earlier', () => {
  const sameInstant = leg({ dte: 1.00001, iv: 70 });   // dte read slightly before eventDays was
  const m = E.eventModel([sameInstant, front, back], 1);
  assert.equal(m.front.dte, 4);
  assert.equal(E.ivAfter(sameInstant, m, 1), 70);
});

test('a typed IV after is ignored for a leg that expires before the report', () => {
  const m = E.eventModel([front, back], 1);
  const gone = { ...leg({ dte: 0.5, iv: 80 }), ivAfter: 20 };
  assert.equal(E.afterLegs([gone], m, 1, [1])[0].iv, 80);
});

test('expiries close together give a warning: the forward vol between them is noisy', () => {
  const m = E.eventModel([leg({ dte: 4, iv: 60 }), leg({ id: 2, dte: 5, iv: 55 })], 1);
  assert.match(m.note, /noisy/);
});

test('frames are priced again when today\'s side changes, not only the after side', () => {
  const body = (iv) => ({ spot: 100, at_days: [1], legs: [{ iv, dte: 4, premium: 1 }] });
  assert.notEqual(Panel.frameKey([body(0.6), body(0.3)]), Panel.frameKey([body(0.7), body(0.3)]));
});
