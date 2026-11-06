'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../modules/portfolio/web/portfolio.js');

// The shape GET /api/journal/trades returns (only the fields the helpers read).
const leg = (kind, strike, expiry, netQty, avgCost, extra) => ({
  kind, strike, expiry, multiplier: kind === 'stock' ? 1 : 100, net_qty: netQty, avg_cost: avgCost, ...extra });
const trade = (id, underlying, strategy, legs, status = 'open') => ({ id, underlying, strategy, status, legs });

const putSpread = trade(12, 'spy', 'bull_put_spread', [
  leg('put', 540, '2026-12-18', -1, 3.0), leg('put', 535, '2026-12-18', 1, 1.8)]);
const shares = trade(7, 'aapl', 'stock', [leg('stock', null, null, 100, 212.4)]);

test('tradeLabel names a trade by id and strategy', () => {
  assert.equal(P.tradeLabel(putSpread), '#12 bull put spread');
  assert.equal(P.tradeLabel({ id: 3 }), '#3');
});

test('journalRows turns open trades into position rows in the broker shape', () => {
  const rows = P.journalRows([putSpread, shares]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { symbol: 'SPY', sec_type: 'OPT', kind: 'put', strike: 540, expiry: '2026-12-18',
    multiplier: 100, qty: -1, avg_cost: 3, trading_class: 'SPY', trade_id: 12, account: '#12 bull put spread' });
  assert.deepEqual(rows[2], { symbol: 'AAPL', sec_type: 'STK', kind: 'stock', strike: null, expiry: null,
    multiplier: 1, qty: 100, avg_cost: 212.4, trade_id: 7, account: '#7 stock' });
});

test('journalRows skips closed trades, flat legs and malformed input', () => {
  const closed = trade(1, 'qqq', 'long_call', [leg('call', 500, '2026-12-18', 1, 2)], 'closed');
  const partly = trade(2, 'iwm', 'custom', [leg('call', 200, '2026-12-18', 0, 0), leg('put', 190, '2026-12-18', 2, 1.1)]);
  const rows = P.journalRows([closed, partly, null, { id: 9, status: 'open' }, { status: 'open', legs: [{}] }]);
  assert.deepEqual(rows.map((r) => [r.symbol, r.strike, r.qty]), [['IWM', 190, 2]]);
  assert.deepEqual(P.journalRows(undefined), []);
});

test('journalRows rows go through summarise like broker rows', () => {
  const s = P.summarise(P.journalRows([putSpread]));
  assert.equal(s.totals.positions, 2);
  assert.equal(s.totals.net, -120); // -1 * 3.00 * 100 + 1 * 1.80 * 100
});

test('contractKey matches options by contract and stock by symbol', () => {
  const opt = { symbol: 'spy', sec_type: 'OPT', kind: 'put', strike: 540, expiry: '2026-12-18' };
  assert.equal(P.contractKey(opt), P.contractKey({ ...opt, symbol: 'SPY', strike: 540.0, account: 'U1' }));
  assert.notEqual(P.contractKey(opt), P.contractKey({ ...opt, kind: 'call' }));
  assert.notEqual(P.contractKey(opt), P.contractKey({ ...opt, strike: 535 }));
  assert.equal(P.contractKey({ symbol: 'AAPL', sec_type: 'STK', kind: 'stock' }), P.contractKey({ symbol: 'aapl', sec_type: 'STK' }));
});

test('tradeHref links to the journal trade page, only for a whole-number id', () => {
  assert.equal(P.tradeHref(12), '/journal/trade?id=12');
  assert.equal(P.tradeHref('12'), null);
  assert.equal(P.tradeHref(1.5), null);
  assert.equal(P.tradeHref(undefined), null);
});
