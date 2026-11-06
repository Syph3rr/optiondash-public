'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../modules/portfolio/web/cardview.js');

const opt = (kind, strike, expiry, qty, avg_cost) =>
  ({ symbol: 'SPY', sec_type: 'OPT', kind, strike, expiry, qty, avg_cost, multiplier: 100 });
const stk = (qty, avg_cost) => ({ symbol: 'AAPL', sec_type: 'STK', kind: 'stock', strike: null, expiry: null, qty, avg_cost, multiplier: 1 });

test('legView: a short option reads Short, unsigned qty, strike and right in words', () => {
  const v = C.legView(opt('call', 680, '2026-11-13', -2, 3.2));
  assert.deepEqual(v, { side: 'short', qty: 2, kind: 'call', what: '680 Call', expiry: '2026-11-13',
    expiryText: '13 Nov 26', price: 3.2 });
});

test('legView: a long put, and a fractional strike without a trailing .0', () => {
  assert.equal(C.legView(opt('put', 340.5, '2026-12-18', 1, 2)).what, '340.5 Put');
  assert.equal(C.legView(opt('put', 340, '2026-12-18', 1, 2)).side, 'long');
});

test('legView: stock is "shares", has no expiry, and a negative qty is a short', () => {
  const long = C.legView(stk(100, 328.5));
  assert.deepEqual([long.side, long.qty, long.kind, long.what, long.expiry, long.expiryText], ['long', 100, 'stock', 'AAPL shares', null, '']);
  assert.equal(C.legView(stk(-50, 10)).side, 'short');
});

test('strategyTitle: a journal strategy id becomes a sentence-case title, with a fallback', () => {
  assert.equal(C.strategyTitle('bull_put_spread'), 'Bull put spread');
  assert.equal(C.strategyTitle('covered_call'), 'Covered call');
  assert.equal(C.strategyTitle('stock'), 'Stock');
  assert.equal(C.strategyTitle(null), 'Trade');
  assert.equal(C.strategyTitle(''), 'Trade');
});

test('expirySummary: the nearest upcoming expiry, days away, and how many others there are', () => {
  const rows = [opt('put', 335, '2026-11-20', 1, 1), opt('put', 335, '2026-11-13', -1, 1), stk(100, 1)];
  assert.deepEqual(C.expirySummary(rows, '2026-11-06'), { expiry: '2026-11-13', text: '13 Nov 26', days: 7, more: 1 });
});

test('expirySummary: today is 0 days, a single expiry has no others, stock only gives null', () => {
  assert.deepEqual(C.expirySummary([opt('call', 1, '2026-11-06', 1, 1)], '2026-11-06'),
    { expiry: '2026-11-06', text: '6 Nov 26', days: 0, more: 0 });
  assert.equal(C.expirySummary([stk(1, 1)], '2026-11-06'), null);
  assert.equal(C.expirySummary([], '2026-11-06'), null);
});

test('expirySummary: when every expiry is past it shows the latest one, with negative days', () => {
  const rows = [opt('call', 1, '2026-11-01', 1, 1), opt('call', 1, '2026-11-04', 1, 1)];
  assert.deepEqual(C.expirySummary(rows, '2026-11-06'), { expiry: '2026-11-04', text: '4 Nov 26', days: -2, more: 1 });
});

test('dteText: short and plain', () => {
  assert.equal(C.dteText(7), '7d');
  assert.equal(C.dteText(1), '1d');
  assert.equal(C.dteText(0), 'today');
  assert.equal(C.dteText(-3), 'expired');
});

test('costWord: paying is a Debit, receiving a Credit; neither is coloured as profit or loss', () => {
  assert.deepEqual(C.costWord(32540), { word: 'Debit', amount: 32540 });
  assert.deepEqual(C.costWord(-490), { word: 'Credit', amount: 490 });
  assert.deepEqual(C.costWord(0), { word: 'Flat', amount: 0 });
  assert.deepEqual(C.costWord(NaN), { word: 'Flat', amount: 0 });
  assert.deepEqual(C.costWord(null), { word: 'Flat', amount: 0 });
});
