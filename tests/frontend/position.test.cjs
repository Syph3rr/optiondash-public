'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const K = require('../../modules/analyser/web/controls.js');
const P = require('../../modules/analyser/web/position.js');

// 2026-11-05 09:30 New York (EST) + 3 days = 2026-11-08 09:30
const ENTRY_MS = K.nyToMs('2026-11-05', 570);
const NOW = ENTRY_MS + 3 * K.DAY_MS;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

const put = (o) => ({ enabled: true, kind: 'put', long: false, qty: 1, strike: 540, dte: 40, iv: 20,
  premium: null, fill: null, multiplier: 100, live: null, listed: null, ...o });

test('hasFills: only enabled legs with a quantity count', () => {
  assert.equal(P.hasFills([put()]), false);
  assert.equal(P.hasFills([put({ fill: 0 })]), true);
  assert.equal(P.hasFills([put({ fill: 2, enabled: false })]), false);
  assert.equal(P.hasFills([put({ fill: 2, qty: 0 })]), false);
  assert.equal(P.hasFills([put({ fill: -1 })]), false);
});

test('basisOf: my fill, else the leg price as before', () => {
  assert.equal(P.basisOf(put({ fill: 3, premium: 2 })), 3);
  assert.equal(P.basisOf(put({ premium: 2 })), 2);
  assert.equal(P.basisOf(put()), null);
});

test('currentOf: stock at spot, option at its price, else theo', () => {
  assert.equal(P.currentOf({ kind: 'stock', premium: 90 }, 1, 101), 101);
  assert.equal(P.currentOf(put({ premium: 2.5 }), 2.2, 550), 2.5);
  assert.equal(P.currentOf(put(), 2.2, 550), 2.2);
  assert.equal(P.currentOf(put(), undefined, 550), null);
});

test('positionRows: change and P&L use side, qty and multiplier', () => {
  const legs = [
    put({ fill: 3, premium: 2 }),                                     // short 1 put: 3 -> 2 = +100
    put({ long: true, strike: 535, qty: 2, fill: 1.8, premium: 1.2 }), // long 2: -0.6 x 200 = -120
    put({ enabled: false, fill: 5 }),                                  // not in the position
    put({ strike: 530 }),                                              // no fill: shown, no P&L
    { enabled: true, kind: 'stock', long: true, qty: 100, multiplier: 1, fill: 100, premium: null, strike: 0, dte: 0, iv: 18 },
  ];
  const rows = P.positionRows(legs, [2.1, 1.1, 0, 0.9, undefined], 101.5);
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 3, 4]);
  near(rows[0].pnl, 100);
  near(rows[1].pnl, -120);
  assert.equal(rows[2].fill, null);
  assert.equal(rows[2].pnl, null);
  assert.equal(rows[2].current, 0.9);
  near(rows[3].pnl, 150);
  assert.equal(rows[0].label, 'SELL 1 540 put');
  assert.equal(rows[3].label, 'BUY 100 stock');
  const t = P.totals(rows);
  near(t.pnl, 130);
  assert.equal(t.filled, 3);
  assert.equal(t.unpriced, 0);
});

test('totals counts a filled leg with no current price as unpriced', () => {
  const rows = P.positionRows([put({ fill: 3 })], [undefined], 550);
  assert.equal(rows[0].pnl, null);
  assert.deepEqual(P.totals(rows), { pnl: 0, filled: 1, unpriced: 1 });
});

test('entryCheck: names what is missing; days held from 09:30 New York', () => {
  const none = P.entryCheck(null, NOW, K);
  assert.deepEqual(none, { ok: false, missing: ['entry date', 'underlying at entry', 'IV at entry'], daysHeld: null });
  assert.deepEqual(P.entryCheck({ date: '5/11/26', spot: 550, iv: 20 }, NOW, K).missing, ['entry date']);
  const ok = P.entryCheck({ date: '2026-11-05', spot: 550, iv: 20 }, NOW, K);
  assert.equal(ok.ok, true);
  near(ok.daysHeld, 3);
  assert.equal(P.entryCheck({ date: '2026-12-01', spot: 550, iv: 20 }, NOW, K).daysHeld, 0);
});

test('entryIvs keeps the skew and moves the mean to the IV at entry', () => {
  const legs = [put({ iv: 22 }), put({ iv: 18 }), { kind: 'stock', iv: 18 }];
  assert.deepEqual(P.entryIvs(legs, 25), [27, 23, 18]);
  assert.deepEqual(P.entryIvs([put({ iv: 1 })], 0.1), [0.5]);
});

// A stand-in for the engine: linear, so each step is known exactly.
const fakeTheo = (spot, l) => (l.kind === 'stock' ? spot : spot * 0.01 + l.dte * 0.1 + l.iv * 10);
const reply = (body) => ({ legs: body.legs.map((l) => ({ theo: fakeTheo(body.spot, l) })) });

const S = {
  spot: 560, rate: 4, divy: 1, model: 'american',
  entry: { date: '2026-11-05', spot: 550, iv: 25 },
  legs: [put({ fill: 3, premium: 2.4, iv: 20 }), put({ enabled: false, fill: 9 }), put({ strike: 530, iv: 22 })],
};

test('repricingBodies: entry state and three states now, unit legs, no IV shift', () => {
  const check = P.entryCheck(S.entry, NOW, K);
  const b = P.repricingBodies(S, check);
  assert.deepEqual(b.legs, [0, 2]);
  assert.equal(b.entry.spot, 550);
  assert.equal(b.now.spot, 560);
  assert.equal(b.now.iv_shift, 0);
  assert.equal(b.now.rate, 0.04);
  assert.equal(b.now.model, 'american');
  assert.equal(b.now.legs.length, 6);
  assert.deepEqual(b.entry.legs, b.now.legs.slice(0, 2));
  const [e0] = b.entry.legs;
  assert.deepEqual({ ...e0, dte: +e0.dte.toFixed(9), iv: +e0.iv.toFixed(9) },
    { kind: 'put', long: true, qty: 1, strike: 540, dte: 43, iv: 0.24, premium: null, multiplier: 1, enabled: true });
  near(b.now.legs[2].dte, 40);           // V2: now DTE, entry IV
  near(b.now.legs[2].iv, 0.24);
  near(b.now.legs[4].iv, 0.20);          // V3: now IV
  const without = P.repricingBodies(S, P.entryCheck({}, NOW, K));
  assert.equal(without.entry, null);
  assert.equal(without.now.legs.length, 2);
});

test('attribution: exact steps, other = what the model does not explain, sums to the total', () => {
  const check = P.entryCheck(S.entry, NOW, K);
  const b = P.repricingBodies(S, check);
  const nowReply = reply(b.now), entryReply = reply(b.entry);
  const theos = P.theosNow(S, b, nowReply);
  assert.equal(theos[1], undefined);
  near(theos[0], fakeTheo(560, b.now.legs[4]));
  const rows = P.positionRows(S.legs, theos, S.spot);
  const a = P.attribution(S, b, rows, entryReply, nowReply);
  const scale = -100;                                  // short 1 x 100
  near(a.move, (560 - 550) * 0.01 * scale);           // spot step only
  near(a.time, (40 - 43) * 0.1 * scale);              // 3 days held
  near(a.iv, (0.20 - 0.24) * 10 * scale);             // mean IV 21 -> 25 at entry, leg 20 -> 24
  near(a.total, (2.4 - 3) * scale);
  near(a.move + a.time + a.iv + a.other, a.total);
});

test('attribution is null when the engine left a price out', () => {
  const check = P.entryCheck(S.entry, NOW, K);
  const b = P.repricingBodies(S, check);
  const rows = P.positionRows(S.legs, [2.4, undefined, 1], S.spot);
  assert.equal(P.attribution(S, b, rows, { legs: [] }, reply(b.now)), null);
  const broken = reply(b.now);
  broken.legs[0] = null;
  assert.equal(P.attribution(S, b, rows, reply(b.entry), broken), null);
});

// ---------------------------------------------------------------- live prices
const listed = { symbol: 'SPY', expiry: '20261218', trading_class: 'SPY' };
const live = { symbol: 'SPY', expiry: '20261218', strike: 535, right: 'P', trading_class: 'SPY' };

test('contractFor: the link, else the picked date and strike; never stock or another symbol', () => {
  assert.equal(P.contractFor(put({ live }), 'SPY'), live);
  assert.deepEqual(P.contractFor(put({ listed }), 'SPY'),
    { symbol: 'SPY', expiry: '20261218', strike: 540, right: 'P', trading_class: 'SPY' });
  assert.equal(P.contractFor(put({ listed }), 'QQQ'), null);
  assert.equal(P.contractFor(put(), 'SPY'), null);
  assert.equal(P.contractFor({ kind: 'stock', listed }, 'SPY'), null);
});

test('contractsToQuote: each contract once, position legs only, capped', () => {
  const legs = [put({ listed }), put({ listed }), put({ live }), put({ listed, enabled: false, strike: 1 })];
  assert.equal(P.contractsToQuote(legs, 'SPY').length, 2);
  assert.equal(P.contractsToQuote(legs, 'SPY', 1).length, 1);
});

test('priceOf: mid, else last, else nothing', () => {
  assert.equal(P.priceOf({ bid: 1.0, ask: 1.2, last: 5 }), 1.1);
  assert.equal(P.priceOf({ bid: null, ask: 1.2, last: 1.15 }), 1.15);
  assert.equal(P.priceOf({ bid: 0, ask: 0, last: 0.05 }), 0.05);
  assert.equal(P.priceOf({ bid: 2, ask: 1, last: null }), null);   // crossed: not a price
  assert.equal(P.priceOf({}), null);
  assert.equal(P.priceOf(null), null);
});

test('applyQuotes sets the price of matched legs only, leaving the originals alone', () => {
  const legs = [put({ listed, premium: 9 }), put({ live, premium: 9 }), put({ premium: 9 }), { kind: 'stock', enabled: true, qty: 1, premium: 9 }];
  const quotes = [
    { symbol: 'SPY', expiry: '20261218', strike: 540.0, right: 'P', trading_class: 'SPY', bid: 2, ask: 2.2, iv: 0.2345 },
    { symbol: 'SPY', expiry: '20261218', strike: 535, right: 'P', trading_class: 'SPY', bid: null, ask: null, last: null },
    'junk',
  ];
  const out = P.applyQuotes(legs, quotes, 'SPY');
  assert.equal(out.legs[0].premium, 2.1);
  assert.equal(out.legs[0].iv, 23.45, 'IV follows the quote');
  assert.equal(out.legs[1].premium, 9);
  assert.equal(out.legs[2], legs[2]);
  assert.equal(out.priced, 1);
  assert.equal(out.missed, 1);
  assert.equal(legs[0].premium, 9);
});

test('applyQuotes keeps a typed IV', () => {
  const q = { symbol: 'SPY', expiry: '20261218', strike: 540, right: 'P', trading_class: 'SPY', bid: 2, ask: 2.2, iv: 0.3 };
  const out = P.applyQuotes([put({ listed, ivOverride: true, iv: 19 })], [q], 'SPY');
  assert.equal(out.legs[0].iv, 19);
  assert.equal(out.legs[0].premium, 2.1);
});

test('applyQuotes keeps a typed premium as my fill when asked to promote', () => {
  const q = { symbol: 'SPY', expiry: '20261218', strike: 540, right: 'P', trading_class: 'SPY', bid: 2, ask: 2.2, iv: 0.3 };
  const legs = [put({ listed, premium: 3.4 }), put({ listed, premium: 3.4, fill: 3 }), put({ listed })];
  const out = P.applyQuotes(legs, [q], 'SPY', { promote: true });
  assert.deepEqual(out.legs.map((l) => [l.fill, l.premium]), [[3.4, 2.1], [3, 2.1], [null, 2.1]]);
  assert.equal(out.promoted, 1, 'only the typed premium without a fill was promoted');
  assert.equal(P.basisOf(out.legs[0]), 3.4, 'cost basis survives the refresh');
  // Later refreshes in Market mode: the premium is already a market price, so nothing is promoted.
  const again = P.applyQuotes(out.legs, [q], 'SPY');
  assert.equal(again.promoted, 0);
  assert.deepEqual(again.legs.map((l) => l.fill), [3.4, 3, null]);
});
