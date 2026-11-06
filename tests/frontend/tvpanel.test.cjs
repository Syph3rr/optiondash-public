'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../modules/analyser/web/tvpanel.js');

const page = () => fs.readFileSync(path.join(__dirname, '../../modules/analyser/web/index.html'), 'utf8');

test('the price chart is one of the chart card\'s views, not a card of its own', () => {
  assert.equal(P.TV_VIEW, 'tv');
  assert.equal(P.isTvView('tv'), true);
  for (const v of ['payoff', 'heat', 'gprice', 'gtime', '', undefined, null]) assert.equal(P.isTvView(v), false);
});

test('the Chart tab sits second, right after P&L and before Heatmap', () => {
  const views = [...page().matchAll(/class="tab[^"]*" data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(views, ['payoff', P.TV_VIEW, 'heat', 'gprice', 'gtime']);
});

test('the page tells the panel about every view switch, and never prices into the hidden plot', () => {
  const html = page();
  assert.match(html, new RegExp(`new CustomEvent\\('${P.VIEW_EVENT}'`), 'showView dispatches the view event');
  assert.match(html, /isTvView|S\.view === 'tv'/, 'renderChart skips the Plotly chart on the price-chart view');
});

test('the chart follows the loaded symbol, else the starting one', () => {
  assert.equal(P.pickSymbol({ loaded: 'aapl', initial: 'SPX' }), 'AAPL');
  assert.equal(P.pickSymbol({ loaded: '', initial: ' spx ' }), 'SPX');
  assert.equal(P.pickSymbol({ loaded: null, initial: 'NDX' }), 'NDX');
  assert.equal(P.pickSymbol({}), '');
  assert.equal(P.pickSymbol(), '');
});

test('rebuilds only when the symbol or theme changes, or when forced', () => {
  const shown = { symbol: 'FOREXCOM:SPXUSD', theme: 'dark' };
  assert.equal(P.needsBuild({ symbol: '', theme: '' }, shown), true);
  assert.equal(P.needsBuild(shown, { ...shown }), false);
  assert.equal(P.needsBuild(shown, { ...shown, theme: 'light' }), true);
  assert.equal(P.needsBuild(shown, { ...shown, symbol: 'AAPL' }), true);
  assert.equal(P.needsBuild(shown, { ...shown }, true), true);
  assert.equal(P.needsBuild(null, shown), true);
  assert.equal(P.needsBuild(shown, { symbol: '', theme: 'dark' }, true), false); // nothing to chart
});

test('the symbol event name matches what market.js dispatches', () => {
  const market = fs.readFileSync(path.join(__dirname, '../../modules/analyser/web/market.js'), 'utf8');
  // The detail may carry more fields (prevSpot, spot); the panel only needs `symbol`.
  assert.match(market, new RegExp(`new CustomEvent\\('${P.SYMBOL_EVENT}', \\{ detail: \\{ symbol[,\\s}]`));
});
