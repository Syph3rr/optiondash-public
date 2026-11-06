'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../modules/portfolio/web/portfolio.js');

test('the CSV template has a header and one stock, call and put example', () => {
  const [header, ...rows] = P.TEMPLATE_CSV.trim().split('\n');
  assert.equal(header, 'type,symbol,qty,avg_cost,strike,expiry,multiplier,trading_class,account');
  assert.deepEqual(rows.map((r) => r.split(',')[0]), ['stock', 'call', 'put']);
  assert.match(rows[0], /^stock,AAPL,100,[\d.]+,,,/, 'a stock leaves strike and expiry blank');
});

test('savedWhen formats an ISO time as a short local date and time', () => {
  const iso = new Date(2026, 10, 6, 9, 5).toISOString();
  assert.equal(P.savedWhen(iso), '6 Nov 26 09:05');
  assert.equal(P.savedWhen('not a date'), 'an unknown time');
});

test('snapshotSource names where the saved positions came from', () => {
  assert.equal(P.snapshotSource({ source: 'csv' }), 'CSV upload');
  assert.equal(P.snapshotSource({ source: 'tws' }), 'last TWS read');
});

test('cashForm prefills from the first saved account row, blank for missing figures', () => {
  const form = P.cashForm([{ currency: 'AUD', cash: 1500.5, net_liquidation: null, available_funds: 20, buying_power: null }]);
  assert.deepEqual(form, { currency: 'AUD', cash: '1500.5', net_liquidation: '', available_funds: '20', buying_power: '' });
  assert.deepEqual(P.cashForm([]), { currency: 'USD', cash: '', net_liquidation: '', available_funds: '', buying_power: '' });
});

test('cashBody turns the form into numbers or null, and names a bad figure', () => {
  const ok = P.cashBody({ currency: ' aud ', cash: '$25,000.50', net_liquidation: '', available_funds: '-3', buying_power: ' ' });
  assert.deepEqual(ok, { body: { currency: 'AUD', cash: 25000.5, net_liquidation: null, available_funds: -3, buying_power: null } });
  assert.match(P.cashBody({ currency: 'USD', cash: 'lots' }).error, /Cash must be a number/);
  assert.match(P.cashBody({ currency: 'US', cash: '' }).error, /Currency/);
});
