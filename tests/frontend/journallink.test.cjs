'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const K = require('../../modules/analyser/web/controls.js');
const J = require('../../modules/analyser/web/journallink.js');

// 2026-11-04 15:00 New York (EST, UTC-5)
const NOW = Date.UTC(2026, 10, 4, 20, 0);

const exec = (qty, price, event = 'open') => ({ qty, price, event });
const leg = (o) => ({ multiplier: 100, executions: [], net_qty: 0, avg_cost: 0, ...o });

const putSpread = {
  id: 7, underlying: 'spy', strategy: 'bull_put_spread', iv_entry: 22.5, underlying_entry: 550,
  legs: [
    leg({ kind: 'put', strike: 540, expiry: '2026-12-18', net_qty: -1, avg_cost: 3,
      executions: [exec(-1, 3)] }),
    leg({ kind: 'put', strike: 535, expiry: '2026-12-18', net_qty: 1, avg_cost: 1.8,
      executions: [exec(1, 1.8)] }),
  ],
};

test('an open trade loads its current legs with my fills and sides', () => {
  const a = J.toAnalyser(putSpread, NOW, K);
  assert.equal(a.source, 'current');
  assert.equal(a.symbol, 'SPY');
  assert.equal(a.spot, 550);
  assert.equal(a.model, 'american');
  assert.deepEqual(a.legs.map((l) => [l.long, l.qty, l.strike, l.fill, l.premium, l.iv, l.multiplier]),
    [[false, 1, 540, 3, null, 22.5, 100], [true, 1, 535, 1.8, null, 22.5, 100]]);
});

test('legs keep their exact expiry: DTE to 16:00 New York and a listed date', () => {
  const [l] = J.toAnalyser(putSpread, NOW, K).legs;
  // Nov 4 15:00 -> Dec 18 16:00 EST = 44 days + 1 hour
  assert.ok(Math.abs(l.dte - (44 + 1 / 24)) < 1e-9, String(l.dte));
  assert.deepEqual(l.listed, { symbol: 'SPY', expiry: '20261218', trading_class: 'SPY' });
});

test('a closed trade loads the opening position, ignoring later fills', () => {
  const closed = {
    id: 3, underlying: 'QQQ', strategy: 'short_put', legs: [
      leg({ kind: 'put', strike: 480, expiry: '2026-12-18', net_qty: 0,
        executions: [exec(-1, 2), exec(-1, 4), exec(2, 1, 'close')] }),
    ],
  };
  const a = J.toAnalyser(closed, NOW, K);
  assert.equal(a.source, 'initial');
  assert.equal(a.legs.length, 1);
  assert.equal(a.legs[0].long, false);
  assert.equal(a.legs[0].qty, 2);
  assert.equal(a.legs[0].fill, 3, 'average open price');
  assert.equal(a.legs[0].premium, null);
  assert.equal(a.legs[0].iv, 18, 'no iv_entry falls back to the presets default');
});

test('a stock leg keeps shares and multiplier 1 with no strike or DTE', () => {
  const covered = { id: 1, underlying: 'AAPL', strategy: 'covered_call', legs: [
    leg({ kind: 'stock', strike: null, expiry: null, multiplier: 1, net_qty: 100, avg_cost: 190 }),
    leg({ kind: 'call', strike: 200, expiry: '2026-12-18', net_qty: -1, avg_cost: 2.5 }),
  ] };
  const [s, c] = J.toAnalyser(covered, NOW, K).legs;
  assert.deepEqual([s.kind, s.long, s.qty, s.multiplier, s.strike, s.dte, s.listed], ['stock', true, 100, 1, 0, 0, null]);
  assert.equal(c.long, false);
});

test('legs on different expiries each keep their own date; expired legs settle at intrinsic', () => {
  const cal = { id: 9, underlying: 'SPY', strategy: 'calendar', legs: [
    leg({ kind: 'call', strike: 550, expiry: '2026-10-30', net_qty: -1, avg_cost: 2 }),
    leg({ kind: 'call', strike: 550, expiry: '2027-01-15', net_qty: 1, avg_cost: 6 }),
  ] };
  const a = J.toAnalyser(cal, NOW, K);
  assert.equal(a.expired, 1);
  assert.equal(a.legs[0].dte, 0);
  assert.equal(a.legs[0].listed, null);
  assert.equal(a.legs[1].listed.expiry, '20270115');
  assert.ok(a.legs[1].dte > 70);
});

test('entry date, underlying and IV at entry come from the trade when present', () => {
  const a = J.toAnalyser({ ...putSpread, opened_at: '2026-11-02' }, NOW, K);
  assert.deepEqual(a.entry, { date: '2026-11-02', spot: 550, iv: 22.5 });
  const bare = J.toAnalyser({ ...putSpread, opened_at: 'soon', underlying_entry: null, iv_entry: 0 }, NOW, K);
  assert.deepEqual(bare.entry, { date: null, spot: null, iv: null });
  assert.equal(bare.spot, null);
});

test('prefill uses my fill when a leg has one', () => {
  const S = { symbol: 'spy', spot: 551.2, legs: [
    { enabled: true, kind: 'put', long: false, qty: 1, strike: 540, dte: 10, iv: 20, premium: 2.2, fill: 3 },
  ] };
  assert.equal(J.toPrefill(S, [2.1], NOW, K).legs[0].price, 3);
});

test('index symbols get the European model', () => {
  assert.equal(J.modelFor('spx'), 'european');
  assert.equal(J.modelFor('TSLA'), 'american');
});

test('prefill: enabled legs only, sides, NY expiry dates, premium or theo', () => {
  const S = { symbol: 'spy', spot: 551.2, legs: [
    { enabled: true, kind: 'put', long: false, qty: 2, strike: 540, dte: 10, iv: 20, premium: 3.1,
      listed: { symbol: 'SPY', expiry: '20261218', trading_class: 'SPY' } },
    { enabled: true, kind: 'put', long: true, qty: 2, strike: 535, dte: 1.5, iv: 24, premium: null },
    { enabled: false, kind: 'call', long: true, qty: 1, strike: 600, dte: 30, iv: 18, premium: 1 },
    { enabled: true, kind: 'stock', long: true, qty: 100, strike: 0, dte: 0, iv: 18, premium: null },
  ] };
  const p = J.toPrefill(S, [3.05, 1.23456, 0.5, undefined], NOW, K);
  assert.equal(p.underlying, 'SPY');
  assert.equal(p.underlying_entry, 551.2);
  assert.equal(p.iv_entry, 22, 'mean IV of enabled option legs');
  assert.deepEqual(p.legs, [
    { kind: 'put', side: 'sell', qty: 2, strike: 540, expiry: '2026-12-18', price: 3.1 },
    // Nov 4 15:00 + 1.5 days = Nov 6 03:00 New York
    { kind: 'put', side: 'buy', qty: 2, strike: 535, expiry: '2026-11-06', price: 1.2346 },
    { kind: 'stock', side: 'buy', qty: 100, strike: null, expiry: null, price: 551.2 },
  ]);
});

test('trade id comes only from a clean ?journal_trade=N', () => {
  assert.equal(J.tradeIdFrom('?journal_trade=42'), 42);
  assert.equal(J.tradeIdFrom('?journal_trade=4x'), null);
  assert.equal(J.tradeIdFrom(''), null);
  assert.equal(J.tradeLabel(putSpread), '#7 spy bull put spread');
});
