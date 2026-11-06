'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../modules/portfolio/web/portfolio.js');

const opt = (symbol, kind, strike, expiry, qty, avg_cost, multiplier = 100) =>
  ({ symbol, sec_type: 'OPT', kind, strike, expiry, qty, avg_cost, multiplier, account: 'U1' });
const stk = (symbol, qty, avg_cost) =>
  ({ symbol, sec_type: 'STK', kind: 'stock', strike: null, expiry: null, qty, avg_cost, multiplier: 1, account: 'U1' });

test('cost is signed: long pays, short receives, options scale by multiplier', () => {
  assert.equal(P.cost(opt('AAPL', 'call', 200, '2026-12-18', 2, 3.5)), 700);
  assert.equal(P.cost(opt('AAPL', 'put', 190, '2026-12-18', -1, 2)), -200);
  assert.equal(P.cost(stk('AAPL', 100, 150)), 15000);
  assert.equal(P.cost(stk('AAPL', -10, 150)), -1500);
});

test('summarise groups by underlying with net and gross cost', () => {
  const s = P.summarise([
    opt('AAPL', 'call', 200, '2026-12-18', 2, 3.5),
    opt('AAPL', 'put', 190, '2026-12-18', -1, 2),
    stk('MSFT', 10, 400),
  ]);
  const aapl = s.byUnderlying.find((r) => r.symbol === 'AAPL');
  assert.deepEqual([aapl.legs, aapl.net, aapl.gross], [2, 500, 900]);
  const msft = s.byUnderlying.find((r) => r.symbol === 'MSFT');
  assert.deepEqual([msft.legs, msft.shares, msft.net], [1, 10, 4000]);
});

test('byExpiry covers option legs only, earliest first', () => {
  const s = P.summarise([
    opt('AAPL', 'call', 200, '2027-01-15', 1, 5),
    opt('AAPL', 'call', 200, '2026-12-18', 1, 3),
    stk('AAPL', 100, 150),
  ]);
  assert.deepEqual(s.byExpiry.map((r) => r.expiry), ['2026-12-18', '2027-01-15']);
  assert.equal(s.byExpiry[0].gross, 300);
});

test('totals and empty input', () => {
  const s = P.summarise([opt('A', 'call', 1, '2026-12-18', 1, 1), opt('A', 'put', 1, '2026-12-18', -1, 2)]);
  assert.deepEqual([s.totals.positions, s.totals.net, s.totals.gross], [2, -100, 300]);
  const e = P.summarise([]);
  assert.deepEqual([e.totals.positions, e.byUnderlying.length, e.byExpiry.length], [0, 0, 0]);
});

test('summarise never changes its input and ignores malformed rows', () => {
  const rows = Object.freeze([Object.freeze(stk('A', 1, 1)), null, { symbol: 'B' }]);
  const s = P.summarise(rows);
  assert.equal(s.totals.positions, 1);
});

test('legLabel reads like a trader would say it', () => {
  assert.equal(P.legLabel(opt('AAPL', 'call', 200, '2026-12-18', 1, 1)), 'AAPL 18 Dec 26 200 C');
  assert.equal(P.legLabel(opt('SPX', 'put', 5500.5, '2026-12-18', 1, 1)), 'SPX 18 Dec 26 5500.5 P');
  assert.equal(P.legLabel(stk('AAPL', 1, 1)), 'AAPL stock');
});

// ---------------------------------------------------------------- v2: Greeks and live P&L

const optTc = (symbol, kind, strike, expiry, qty, avg, tc) => ({ ...opt(symbol, kind, strike, expiry, qty, avg), trading_class: tc });

test('quoteRequests groups option legs by underlying with YYYYMMDD expiries and one right letter', () => {
  const reqs = P.quoteRequests([
    optTc('SPY', 'call', 600, '2026-12-18', 1, 5, 'SPY'),
    optTc('SPY', 'put', 550, '2026-12-18', -1, 3, 'SPY'),
    optTc('AAPL', 'put', 190, '2027-01-15', 2, 2, 'AAPL'),
    stk('SPY', 100, 500),
  ]);
  assert.deepEqual(reqs.map((r) => r.symbol).sort(), ['AAPL', 'SPY']);
  const spy = reqs.find((r) => r.symbol === 'SPY');
  assert.deepEqual(spy.contracts, [
    { symbol: 'SPY', expiry: '20261218', strike: 600, right: 'C', trading_class: 'SPY' },
    { symbol: 'SPY', expiry: '20261218', strike: 550, right: 'P', trading_class: 'SPY' },
  ]);
});

test('quoteRequests splits into batches of at most 32 contracts', () => {
  const many = Array.from({ length: 70 }, (_, i) => optTc('SPY', 'call', 500 + i, '2026-12-18', 1, 1, 'SPY'));
  const reqs = P.quoteRequests(many);
  assert.deepEqual(reqs.map((r) => r.contracts.length), [32, 32, 6]);
  assert.ok(reqs.every((r) => r.symbol === 'SPY'));
});

test('quoteRequests skips options with no trading class (cannot be quoted)', () => {
  assert.deepEqual(P.quoteRequests([opt('SPY', 'call', 600, '2026-12-18', 1, 5)]), []);
});

const quote = (expiry, strike, right, over = {}) =>
  ({ expiry, strike, right, mark: 6, iv: 0.2, dte: 30, ...over });

test('buildLegs makes engine legs: long/short from sign, premium from my fill, IV and DTE from the quote', () => {
  const rows = [optTc('SPY', 'put', 550, '2026-12-18', -2, 3, 'SPY'), stk('SPY', 100, 500)];
  const { legs, unpriced } = P.buildLegs(rows, [quote('20261218', 550, 'P', { iv: 0.25, dte: 40 })]);
  assert.deepEqual(unpriced, []);
  assert.deepEqual(legs[0], { kind: 'put', long: false, qty: 2, strike: 550, dte: 40, iv: 0.25, premium: 3, multiplier: 100, enabled: true });
  assert.deepEqual(legs[1], { kind: 'stock', long: true, qty: 100, strike: 0, dte: 0, iv: 0, premium: 500, multiplier: 1, enabled: true });
});

test('buildLegs reports options it cannot price instead of guessing', () => {
  const rows = [optTc('SPY', 'call', 600, '2026-12-18', 1, 5, 'SPY'), optTc('SPY', 'call', 610, '2026-12-18', 1, 4, 'SPY')];
  const { legs, unpriced } = P.buildLegs(rows, [quote('20261218', 600, 'C', { iv: null })]);
  assert.equal(legs.length, 0);
  assert.deepEqual(unpriced.map((r) => r.strike), [600, 610]);
});

test('unrealised is mark minus my fill, scaled by qty and multiplier; short gains when the mark falls', () => {
  assert.equal(P.unrealised(optTc('A', 'call', 1, '2026-12-18', 2, 3, 'A'), { mark: 5 }), 400);
  assert.equal(P.unrealised(optTc('A', 'put', 1, '2026-12-18', -1, 3, 'A'), { mark: 1 }), 200);
  assert.equal(P.unrealised(stk('A', 10, 100), { mark: 110 }), 100);
  assert.equal(P.unrealised(stk('A', 10, 100), { mark: null }), null);
});

test('sumGreeks adds position Greeks and ignores missing ones', () => {
  const s = P.sumGreeks([{ delta: 10, gamma: 1, theta: -5, vega: 20, rho: 1 }, null, { delta: -4, gamma: 0.5, theta: -1, vega: 5, rho: 0 }]);
  assert.deepEqual(s, { delta: 6, gamma: 1.5, theta: -6, vega: 25, rho: 1 });
  assert.deepEqual(P.sumGreeks([]), { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 });
});

test('findQuote matches by expiry, strike and right', () => {
  const qs = [quote('20261218', 550, 'P'), quote('20261218', 550, 'C', { mark: 9 })];
  assert.equal(P.findQuote(qs, optTc('SPY', 'call', 550, '2026-12-18', 1, 1, 'SPY')).mark, 9);
  assert.equal(P.findQuote(qs, optTc('SPY', 'call', 555, '2026-12-18', 1, 1, 'SPY')), null);
});

// ---------------------------------------------------------------- account cash

const acct = (o = {}) => ({ account: 'U1', currency: 'USD', cash: 1000, net_liquidation: 5000,
  available_funds: 800, buying_power: 1600, ...o });

test('accountSummary of nothing is null, so the UI says "no data" instead of $0', () => {
  assert.equal(P.accountSummary([]), null);
  assert.equal(P.accountSummary(null), null);
  assert.equal(P.accountSummary([{ account: 'U1', currency: 'USD' }, null, 'x']), null);
});

test('accountSummary adds up accounts in the same currency', () => {
  const out = P.accountSummary([acct(), acct({ account: 'U2', cash: 250.5, net_liquidation: 100 })]);
  assert.deepEqual(out, { currency: 'USD', accounts: 2, cash: 1250.5, netLiquidation: 5100,
    availableFunds: 1600, buyingPower: 3200, otherCurrencies: [] });
});

test('accountSummary keeps a missing figure missing, never 0', () => {
  const out = P.accountSummary([acct({ cash: null, available_funds: null }), acct({ account: 'U2', cash: null, available_funds: null })]);
  assert.equal(out.cash, null);
  assert.equal(out.availableFunds, null);
  assert.equal(out.netLiquidation, 10000);
  // one account missing a figure another has: the known one stands, the rest are not guessed
  assert.equal(P.accountSummary([acct({ cash: null }), acct({ account: 'U2', cash: 40 })]).cash, 40);
});

test('accountSummary keeps a negative cash balance (margin) as it is', () => {
  assert.equal(P.accountSummary([acct({ cash: -2500.25 })]).cash, -2500.25);
});

test('accountSummary shows the largest currency and names the others instead of mixing them', () => {
  const out = P.accountSummary([acct({ currency: 'EUR', cash: 90, net_liquidation: 100 }), acct()]);
  assert.equal(out.currency, 'USD');
  assert.equal(out.cash, 1000);
  assert.deepEqual(out.otherCurrencies, ['EUR']);
});

test('accountSummary ignores non-finite numbers and does not change its input', () => {
  const rows = Object.freeze([Object.freeze(acct({ cash: Infinity, net_liquidation: NaN }))]);
  const out = P.accountSummary(rows);
  assert.equal(out.cash, null);
  assert.equal(out.netLiquidation, null);
  assert.equal(out.availableFunds, 800);
});
