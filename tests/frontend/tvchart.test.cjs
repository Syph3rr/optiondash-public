'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const TV = require('../../web/shared/tvchart.js');

test('stocks and ETFs pass through as their ticker, upper-cased and trimmed', () => {
  assert.equal(TV.tvSymbol('aapl'), 'AAPL');
  assert.equal(TV.tvSymbol(' SPY '), 'SPY');
  assert.equal(TV.tvSymbol('BRK.B'), 'BRK.B');
});

test('indexes map to CFDs the free widget can show (the exchange feeds are not available)', () => {
  assert.equal(TV.tvSymbol('SPX'), 'FOREXCOM:SPXUSD');
  assert.equal(TV.tvSymbol('xsp'), 'FOREXCOM:SPXUSD');
  assert.equal(TV.tvSymbol('ndx'), 'FOREXCOM:NSXUSD');
  assert.equal(TV.tvSymbol('RUT'), 'FOREXCOM:US2000');
  assert.equal(TV.tvSymbol('DJX'), 'FOREXCOM:DJI');
  assert.equal(TV.tvSymbol('VIX'), 'CAPITALCOM:VIX');
  for (const s of Object.values(TV.INDEXES)) assert.doesNotMatch(s, /^(SP|TVC|CBOE):/);
});

test('anything that is not a ticker gives null, so nothing odd reaches the widget', () => {
  for (const bad of ['', null, undefined, 'SP Y', '<script>', 'A'.repeat(13), 'AAPL"}']) {
    assert.equal(TV.tvSymbol(bad), null, String(bad));
  }
});

test('the config follows the theme and keeps the widget\'s own symbol search on', () => {
  const dark = TV.config({ symbol: 'SPY', theme: 'dark' });
  assert.equal(dark.symbol, 'SPY');
  assert.equal(dark.theme, 'dark');
  assert.equal(dark.allow_symbol_change, true);
  assert.equal(dark.autosize, true);
  assert.equal(TV.config({ symbol: 'SPY', theme: 'light' }).theme, 'light');
  assert.equal(TV.config({ symbol: 'SPY' }).theme, 'dark'); // unknown theme: dark, like the app
});

test('the config serialises to plain JSON the widget script can read', () => {
  const cfg = TV.config({ symbol: 'SP:SPX', theme: 'light' });
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)), cfg);
});

test('the widget script comes from TradingView over https', () => {
  assert.match(TV.SCRIPT_URL, /^https:\/\/s3\.tradingview\.com\/external-embedding\/embed-widget-advanced-chart\.js$/);
  assert.ok(Object.isFrozen(TV.INDEXES));
});
