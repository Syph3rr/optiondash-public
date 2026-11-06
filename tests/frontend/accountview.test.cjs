'use strict';
// The Account strip (Portfolio page) and the Home card each carry the same pure formatter;
// both copies are exercised against the same cases so they cannot drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');

global.Portfolio = require('../../modules/portfolio/web/portfolio.js');
const copies = {
  page: require('../../modules/portfolio/web/page.js'),
  widgets: require('../../modules/portfolio/web/widgets.js'),
};

const acct = (o) => ({ account: 'DU1', currency: 'USD', cash: null, net_liquidation: null,
  available_funds: null, buying_power: null, ...o });

for (const [name, A] of Object.entries(copies)) {
  test(`${name}: money is whole dollars with separators, exact figure with cents`, () => {
    assert.equal(A.fmtMoney(1234.5, 'USD'), '$1,235');
    assert.equal(A.fmtMoney(1234.5, 'USD', true), '$1,234.50');
    assert.equal(A.fmtMoney(0, 'USD'), '$0');
  });

  test(`${name}: negative cash keeps its sign, non-USD gets a code`, () => {
    assert.equal(A.fmtMoney(-2500, 'USD'), '-$2,500');
    assert.equal(A.fmtMoney(-2500.25, 'USD', true), '-$2,500.25');
    assert.equal(A.fmtMoney(1234, 'EUR'), '1,234 EUR');
    assert.equal(A.fmtMoney(-1234.5, 'EUR', true), '-1,234.50 EUR');
    assert.equal(A.fmtMoney(-0.2, 'USD'), '$0'); // rounds to zero: no "-$0"
  });

  test(`${name}: null and non-numbers are a dash, never $0`, () => {
    for (const v of [null, undefined, NaN, 'x']) assert.equal(A.fmtMoney(v, 'USD'), '—');
  });

  test(`${name}: reply mapping gives the reason texts`, () => {
    assert.equal(A.accountState(409, { error: 'x' }).reason, 'not connected to TWS');
    for (const st of [500, 502, 504]) assert.equal(A.accountState(st, null).reason, 'unavailable');
    assert.equal(A.accountState(200, { accounts: [] }).reason, 'TWS sent no cash figures');
    assert.equal(A.accountState(200, null).reason, 'TWS sent no cash figures');
    assert.equal(A.accountState(200, { accounts: [acct({})] }).reason, 'TWS sent no cash figures');
    assert.equal(A.accountState(200, { accounts: [acct({ cash: 5 })] }).summary.cash, 5);
  });

  test(`${name}: tiles show figures, titles with cents and per-figure gaps`, () => {
    const st = A.accountState(200, { accounts: [acct({ cash: -2500.5, net_liquidation: 5000, buying_power: 1600 })] });
    const t = A.accountTiles(st);
    assert.deepEqual(t.map((x) => x.k), ['Cash', 'Net liquidation', 'Available funds', 'Buying power']);
    assert.deepEqual(t.map((x) => x.v), ['-$2,501', '$5,000', '—', '$1,600']);
    assert.equal(t[0].title, '-$2,500.50');
    assert.equal(t[2].title, '');
    assert.equal(t[2].s, 'TWS sent no cash figures'); // one missing figure is explained, not shown as 0
  });

  test(`${name}: offline tiles are dashes with the reason, other currencies are named`, () => {
    const off = A.accountTiles(A.accountState(409, null));
    assert.ok(off.every((x) => x.v === '—' && x.s === 'not connected to TWS' && x.title === ''));
    const multi = A.accountState(200, { accounts: [acct({ cash: 10, net_liquidation: 100 }),
      acct({ currency: 'EUR', cash: 1, net_liquidation: 5 })] });
    assert.match(A.accountTiles(multi)[0].s, /EUR/);
  });
}

for (const [name, A] of Object.entries(copies)) {
  test(`${name}: saved cash shows its figures, and a missing one reads "not saved"`, () => {
    const s = A.savedAccountState([acct({ cash: 1500 })]);
    assert.equal(s.summary.cash, 1500);
    const tiles = A.accountTiles(s);
    assert.equal(tiles[0].v, '$1,500');
    assert.equal(tiles[1].v, '—');
    assert.equal(tiles[1].s, 'not saved', 'a blank saved figure is not blamed on TWS');
    const none = A.savedAccountState([]);
    assert.equal(none.summary, null);
    assert.ok(A.accountTiles(none).every((t) => t.s === 'not saved'));
  });
}
