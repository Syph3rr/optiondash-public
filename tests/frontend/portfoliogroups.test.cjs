'use strict';
// Portfolio grouping: broker rows labelled by the account's open journal trades (claim-based).
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../modules/portfolio/web/grouping.js');

const leg = (kind, strike, expiry, netQty, avgCost) => ({
  kind, strike, expiry, multiplier: kind === 'stock' ? 1 : 100, net_qty: netQty, avg_cost: avgCost });
const trade = (id, underlying, strategy, legs, extra) => ({ id, underlying, strategy, status: 'open', legs, account_id: 1, ...extra });
const opt = (symbol, kind, strike, qty, avg = 2, account = 'U1') =>
  ({ symbol, sec_type: 'OPT', kind, strike, expiry: '2026-12-18', qty, avg_cost: avg, multiplier: 100, trading_class: symbol, account });
const stk = (symbol, qty, avg = 100) => ({ symbol, sec_type: 'STK', kind: 'stock', strike: null, expiry: null, qty, avg_cost: avg, multiplier: 1, account: 'U1' });

const spread = trade(12, 'spy', 'bull_put_spread', [leg('put', 540, '2026-12-18', -1, 3), leg('put', 535, '2026-12-18', 1, 1.8)]);

const qtys = (rows) => rows.map((r) => [r.label, r.qty]);

test('broker rows fully held by a trade go in that trade\'s group, nothing left over', () => {
  const out = G.groupByTrade({ rows: [opt('SPY', 'put', 540, -1, 3.1), opt('SPY', 'put', 535, 1, 1.7)], trades: [spread], brokerSourced: true });
  assert.equal(out.groups.length, 1);
  const g = out.groups[0];
  assert.deepEqual([g.trade_id, g.label, g.href, g.underlying], [12, '#12 bull put spread', '/journal/trade?id=12', 'SPY']);
  assert.deepEqual(qtys(g.rows), [['SPY 18 Dec 26 540 P', -1], ['SPY 18 Dec 26 535 P', 1]]);
  assert.equal(g.rows[0].avg_cost, 3.1, 'the broker is the source of truth for cost');
  assert.equal(g.rows[0].cost, -310);
  assert.equal(g.net, -310 + 170);
  assert.deepEqual(g.missing, []);
  assert.deepEqual(out.unmatched, []);
});

test('leftover broker quantity goes to Not in journal', () => {
  const out = G.groupByTrade({ rows: [opt('SPY', 'put', 540, -3), opt('SPY', 'put', 535, 1), opt('QQQ', 'call', 500, 2)],
    trades: [spread], brokerSourced: true });
  assert.deepEqual(qtys(out.groups[0].rows), [['SPY 18 Dec 26 540 P', -1], ['SPY 18 Dec 26 535 P', 1]]);
  assert.deepEqual(qtys(out.unmatched), [['SPY 18 Dec 26 540 P', -2], ['QQQ 18 Dec 26 500 C', 2]]);
  assert.equal(out.unmatched[0].cost, -400);
});

test('a journal leg the broker does not hold is a missing line in its group', () => {
  const out = G.groupByTrade({ rows: [opt('SPY', 'put', 535, 1)], trades: [spread], brokerSourced: true });
  const g = out.groups[0];
  assert.deepEqual(qtys(g.rows), [['SPY 18 Dec 26 535 P', 1]]);
  assert.deepEqual(g.missing.map((m) => [m.label, m.qty]), [['SPY 18 Dec 26 540 P', -1]]);
});

test('a partial claim: the broker holds less than the journal says', () => {
  const big = trade(3, 'SPY', 'short_put', [leg('put', 540, '2026-12-18', -5, 3)]);
  const out = G.groupByTrade({ rows: [opt('SPY', 'put', 540, -2)], trades: [big], brokerSourced: true });
  assert.deepEqual(qtys(out.groups[0].rows), [['SPY 18 Dec 26 540 P', -2]]);
  assert.deepEqual(out.groups[0].missing.map((m) => m.qty), [-3]);
  assert.deepEqual(out.unmatched, []);
});

test('the sign must match: a long broker row is not claimed by a short journal leg', () => {
  const short = trade(4, 'SPY', 'short_put', [leg('put', 540, '2026-12-18', -1, 3)]);
  const out = G.groupByTrade({ rows: [opt('SPY', 'put', 540, 1)], trades: [short], brokerSourced: true });
  assert.deepEqual(out.groups[0].rows, []);
  assert.deepEqual(out.groups[0].missing.map((m) => m.qty), [-1]);
  assert.deepEqual(qtys(out.unmatched), [['SPY 18 Dec 26 540 P', 1]]);
});

test('several trades on one contract claim in trade order (oldest id first)', () => {
  const a = trade(8, 'SPY', 'short_put', [leg('put', 540, '2026-12-18', -2, 3)]);
  const b = trade(5, 'SPY', 'short_put', [leg('put', 540, '2026-12-18', -2, 3)]);
  const out = G.groupByTrade({ rows: [opt('SPY', 'put', 540, -3)], trades: [a, b], brokerSourced: true });
  const by = Object.fromEntries(out.groups.map((g) => [g.trade_id, g]));
  assert.deepEqual(by[5].rows.map((r) => r.qty), [-2]);
  assert.deepEqual(by[8].rows.map((r) => r.qty), [-1]);
  assert.deepEqual(by[8].missing.map((m) => m.qty), [-1]);
  assert.deepEqual(out.unmatched, []);
});

test('one contract over two broker rows (two IBKR sub-accounts) is claimed from both', () => {
  const a = trade(1, 'AAPL', 'stock', [leg('stock', null, null, 150, 200)]);
  const rows = [{ ...stk('AAPL', 100), account: 'U1' }, { ...stk('AAPL', 100), account: 'U2' }];
  const out = G.groupByTrade({ rows, trades: [a], brokerSourced: true });
  assert.deepEqual(out.groups[0].rows.map((r) => [r.account, r.qty]), [['U1', 100], ['U2', 50]]);
  assert.deepEqual(out.unmatched.map((r) => [r.account, r.qty]), [['U2', 50]]);
});

test('fractional quantities leave no dust behind', () => {
  const a = trade(1, 'BTC', 'stock', [leg('stock', null, null, 0.3, 10)]);
  const out = G.groupByTrade({ rows: [stk('BTC', 0.1 + 0.2)], trades: [a], brokerSourced: true });
  assert.deepEqual(out.unmatched, []);
  assert.deepEqual(out.groups[0].missing, []);
});

test('groups are ordered by underlying then trade id; closed trades and other junk are ignored', () => {
  const z = trade(1, 'ZZZ', 'stock', [leg('stock', null, null, 1, 1)]);
  const a2 = trade(9, 'AAA', 'stock', [leg('stock', null, null, 1, 1)]);
  const a1 = trade(3, 'AAA', 'stock', [leg('stock', null, null, 1, 1)]);
  const closed = { ...trade(2, 'AAA', 'stock', [leg('stock', null, null, 1, 1)]), status: 'closed' };
  const out = G.groupByTrade({ rows: [], trades: [z, a2, null, closed, a1], brokerSourced: true });
  assert.deepEqual(out.groups.map((g) => g.trade_id), [3, 9, 1]);
});

test('journal-sourced accounts: each open trade is a group of its own legs, nothing missing', () => {
  const shares = trade(7, 'aapl', null, [leg('stock', null, null, 100, 212.4)]);
  const out = G.groupByTrade({ rows: [], trades: [spread, shares], brokerSourced: false });
  assert.deepEqual(out.groups.map((g) => [g.label, g.rows.length, g.missing.length]),
    [['#7', 1, 0], ['#12 bull put spread', 2, 0]]);
  assert.equal(out.groups[1].net, -120);
  assert.deepEqual(out.unmatched, []);
});

test('groupByTrade never changes its input', () => {
  const rows = Object.freeze([Object.freeze(opt('SPY', 'put', 540, -3))]);
  const out = G.groupByTrade({ rows, trades: [Object.freeze(spread)], brokerSourced: true });
  assert.equal(rows[0].qty, -3);
  assert.equal(out.unmatched[0].qty, -2);
});

test('unusable broker rows (futures, garbage) are skipped', () => {
  const out = G.groupByTrade({ rows: [{ symbol: 'ES', sec_type: 'FUT', qty: 1, avg_cost: 1 }, null], trades: [], brokerSourced: true });
  assert.deepEqual(out, { groups: [], unmatched: [] });
});

test('prefillFor turns a position into the New trade hand-off', () => {
  assert.deepEqual(G.prefillFor(opt('SPY', 'put', 540, -2, 3.1), 4), {
    underlying: 'SPY', account_id: 4,
    legs: [{ kind: 'put', side: 'sell', qty: 2, strike: 540, expiry: '2026-12-18', price: 3.1 }] });
  assert.deepEqual(G.prefillFor(stk('aapl', 100, 212.4), 1).legs,
    [{ kind: 'stock', side: 'buy', qty: 100, strike: null, expiry: null, price: 212.4 }]);
  assert.equal(G.prefillFor(opt('SPY', 'put', 540, -2, -0.5), 1).legs[0].price, null, 'a negative cost is not a fill price');
  assert.equal(G.PREFILL_KEY, 'journal.prefill');
  assert.equal(G.NEW_TRADE_URL, '/journal/?new=1&from=analyser');
});

test('combineGreeks adds dollar delta, theta and vega over underlyings; null when nothing priced', () => {
  const c = G.combineGreeks([{ spot: 100, greeks: { delta: 10, theta: -5, vega: 20 } },
    { spot: 50, greeks: { delta: -4, theta: -1, vega: 3 } }, { spot: 10, greeks: null }, null]);
  assert.deepEqual(c, { dollarDelta: 800, theta: -6, vega: 23 });
  assert.equal(G.combineGreeks([]), null);
  assert.equal(G.combineGreeks([{ spot: 1, greeks: null }]), null);
});

test('sumKnown adds the numbers and is null when there are none', () => {
  assert.equal(G.sumKnown([1, null, 2.5]), 3.5);
  assert.equal(G.sumKnown([null, undefined]), null);
});
