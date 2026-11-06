'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../modules/analyser/web/controls.js'); // market.js reads these from window, as in the page
require('../../modules/analyser/web/legrules.js');
require('../../modules/analyser/web/syncplan.js');
const M = require('../../modules/analyser/web/market.js');

const NOW = Date.parse('2026-11-02T15:00:30Z');
const AS_OF = '2026-11-02T15:00:20Z';
const HOURS_OLD = '2026-11-02T09:00:00Z';

const contract = (o = {}) => ({
  symbol: 'SPX', expiry: '20261120', strike: 7580, right: 'C', trading_class: 'SPXW', ...o,
});
const quote = (o = {}) => ({
  ...contract(), multiplier: 100, dte: 9.5, bid: 1, ask: 2, last: 1.5, mark: 1.5, mark_kind: 'mid',
  delta: 0.5, iv: 0.18, iv_source: 'solved', source: 'ibkr', data_type: 'delayed', as_of: AS_OF,
  seen: NOW - 1000, ...o,
});
const leg = (o = {}) => ({
  id: 1, enabled: true, kind: 'call', long: true, qty: 1, strike: 7580, dte: 10, iv: 16,
  premium: 99.05, multiplier: 100, live: contract(), ivOverride: false, ...o,
});
const manual = (o = {}) => leg({ live: undefined, premium: null, ...o });

test('the connect button shows only when there is something to connect', () => {
  assert.equal(M.canConnect({ sidecar: 'online', ibkr: 'disconnected' }), true);
  assert.equal(M.canConnect({ sidecar: 'online', ibkr: 'connected' }), false);
  assert.equal(M.canConnect({ sidecar: 'offline', ibkr: 'disconnected' }), false);
  assert.equal(M.canConnect({ sidecar: 'offline' }), false);
});

test('every data type gets its badge', () => {
  const text = (data_type) => M.badge(quote({ data_type }), NOW).text;
  assert.equal(text('live'), 'LIVE');
  assert.equal(text('delayed'), 'DELAYED');
  assert.equal(text('frozen'), 'FROZEN');
  assert.equal(text('delayed_frozen'), 'FROZEN');
  assert.equal(text('yahoo'), 'YAHOO');
});

test('R24: stale means no successful poll for 30 s, however old as_of is', () => {
  const b = M.badge(quote({ data_type: 'yahoo', as_of: HOURS_OLD, seen: NOW - 5000 }), NOW);
  assert.equal(b.text, 'YAHOO');
  assert.equal(b.stale, false);
});

test('a value no poll has covered for 30 s shows STALE and keeps its source', () => {
  const b = M.badge(quote({ data_type: 'yahoo', as_of: AS_OF, seen: NOW - 30001 }), NOW);
  assert.equal(b.text, 'YAHOO STALE');
  assert.equal(b.stale, true);
});

test('a value exactly 30 s since its last poll is not stale yet', () => {
  assert.equal(M.badge(quote({ seen: NOW - 30000 }), NOW).stale, false);
  assert.equal(M.badge(quote({ seen: NOW - 30001 }), NOW).stale, true);
});

test('badge hover carries as_of, so data age stays visible', () => {
  const b = M.badge(quote({ as_of: HOURS_OLD }), NOW);
  assert.equal(b.stale, false);
  assert.match(b.title, /2026-11-02T09:00:00Z/);
});

test('badge hover says when the price is a last trade, not a live bid/ask', () => {
  const closed = M.badge(quote({ data_type: 'yahoo', bid: null, ask: null, mark_kind: 'last' }), NOW);
  assert.match(closed.title, /last trade, no live bid\/ask/);
  assert.equal(closed.text, 'YAHOO');
  assert.doesNotMatch(M.badge(quote(), NOW).title, /last trade/);
});

test('a value with no recorded poll reads as stale', () => {
  assert.equal(M.badge(quote({ seen: undefined }), NOW).stale, true);
});

test('no badge without a known data type', () => {
  assert.equal(M.badge(null, NOW), null);
  assert.equal(M.badge(quote({ data_type: null }), NOW), null);
  assert.equal(M.badge(quote({ data_type: 'constructor' }), NOW), null);
});

test('linked contracts: one per contract, only this symbol, unlinked legs left out', () => {
  const out = M.linkedContracts([
    leg(), leg({ id: 2 }), leg({ id: 3, live: contract({ strike: 7600 }) }),
    leg({ id: 4, live: null }), manual({ id: 5 }), leg({ id: 6, live: contract({ symbol: 'AAPL' }) }),
  ], 'SPX');
  assert.deepEqual(out.map((c) => c.strike), [7580, 7600]);
  assert.deepEqual(Object.keys(out[0]).sort(),
    ['expiry', 'right', 'strike', 'symbol', 'trading_class']);
});

test('linked contracts stop at the route limit', () => {
  const legs = Array.from({ length: 40 }, (_, i) => leg({ live: contract({ strike: i + 1 }) }));
  assert.equal(M.linkedContracts(legs, 'SPX').length, 32);
  assert.deepEqual(M.linkedContracts([], 'SPX'), []);
});

test('quotes map to legs by contract, not by position', () => {
  const a = leg({ id: 1, strike: 7580, live: contract({ strike: 7580 }) });
  const b = leg({ id: 2, strike: 7600, live: contract({ strike: 7600 }) });
  const out = M.refreshLegs([a, b], [quote({ strike: 7600, iv: 0.3 }), quote({ strike: 7580, iv: 0.2 })]);
  assert.equal(out[0].iv, 20);
  assert.equal(out[1].iv, 30);
});

test('refresh leaves unmatched and manual legs alone and never touches premium', () => {
  const m = manual({ premium: 5 });
  const a = leg();
  const [x, y] = M.refreshLegs([m, a], [quote({ iv: 0.5, mark: 500 })]);
  assert.equal(x, m);
  assert.equal(y.premium, 99.05);
  assert.equal(M.refreshLegs([a], [])[0], a);
});

test('a null underlying price leaves spot alone', () => {
  assert.equal(M.spotFrom(7000, { price: 7100 }), 7100);
  assert.equal(M.spotFrom(7000, { price: null }), 7000);
  assert.equal(M.spotFrom(7000, null), 7000);
  assert.equal(M.spotFrom(7000, { price: 0 }), 7000);
  assert.equal(M.spotFrom(7000, { price: '7100' }), 7000);
});

test('redraw is needed when a value moved or a leg lost its link', () => {
  const a = leg({ dte: 10 });
  assert.equal(M.needsRedraw([a], [{ ...a, dte: 9.9 }]), true);
  assert.equal(M.needsRedraw([a], [{ ...a, dte: 9.9999 }]), false);
  assert.equal(M.needsRedraw([a], [{ ...a, live: null }]), true);
});

test('table age reads in seconds, then minutes', () => {
  assert.equal(M.ageText(4000), 'updated 4s ago');
  assert.equal(M.ageText(59999), 'updated 59s ago');
  assert.equal(M.ageText(60000), 'updated 1m ago');
  assert.equal(M.ageText(754000), 'updated 12m ago');
});

test('chain table pairs calls and puts by strike, in order', () => {
  const table = M.chainTable([quote({ strike: 7600 }), quote({ strike: 7500, right: 'P' }),
    quote({ strike: 7500 }), quote({ strike: 7400, right: 'P' })]);
  assert.deepEqual(table.map((r) => r.strike), [7400, 7500, 7600]);
  assert.equal(table[0].call, null);
  assert.equal(table[0].put.right, 'P');
  assert.equal(table[1].call.right, 'C');
  assert.equal(table[1].put.right, 'P');
  assert.equal(table[2].put, null);
});

test('nearest strike is found for the highlight', () => {
  const table = M.chainTable([quote({ strike: 7500 }), quote({ strike: 7600 })]);
  assert.equal(M.nearestStrike(table, 7560), 7600);
  assert.equal(M.nearestStrike(table, 7510), 7500);
  assert.equal(M.nearestStrike([], 7510), null);
});

test('a quote cell shows the price, or last when the price is missing', () => {
  assert.deepEqual(M.quoteCell(1.5, 9), { text: '1.50', isLast: false });
  assert.deepEqual(M.quoteCell(null, 9), { text: 'L 9.00', isLast: true });
  assert.deepEqual(M.quoteCell(null, null), { text: '—', isLast: false });
});

test('rows that could reach the DOM as non-numbers are dropped', () => {
  const rows = [quote(), quote({ strike: '"><img src=x onerror=alert(1)>' }), quote({ strike: -1 }),
    quote({ right: 'X' }), quote({ expiry: 5 }), null, 'nope'];
  assert.equal(M.validRows(rows).length, 1);
  assert.deepEqual(M.validRows('nope'), []);
  assert.deepEqual(M.validRows(undefined), []);
});

test('expiries that are not well formed are dropped', () => {
  const good = { expiry: '20261120', trading_class: 'SPXW', dte: 18 };
  const list = [good, { expiry: '<b>', trading_class: 'SPXW', dte: 18 },
    { expiry: '20261120', trading_class: 7, dte: 18 }, { expiry: '20261120', trading_class: 'X' }, null];
  assert.deepEqual(M.validExpiries(list), [good]);
  assert.deepEqual(M.validExpiries(null), []);
});

test('only models the page offers are taken from a reply', () => {
  assert.equal(M.knownModel('american'), true);
  assert.equal(M.knownModel('european'), true);
  assert.equal(M.knownModel('futures'), true);
  assert.equal(M.knownModel('<script>'), false);
  assert.equal(M.knownModel(undefined), false);
  assert.equal(M.knownModel('constructor'), false);
});

test('expiry labels read as dates', () => {
  assert.equal(M.expiryLabel({ expiry: '20261120', trading_class: 'SPXW', dte: 18.26 }),
    '2026-11-20 · SPXW · 18.3d');
});

test('chain sources list each label once', () => {
  assert.deepEqual(M.chainSources([quote(), quote({ strike: 1 }), quote({ data_type: 'yahoo' }),
    quote({ data_type: null })]), ['DELAYED', 'YAHOO']);
});

// ---------------------------------------------------------- DTE with no quote
const AT_0900_NY = Date.parse('2026-11-02T14:00:00Z');
const dteOf = (expiry, tradingClass) => M.settlementDte(
  contract({ expiry, trading_class: tradingClass }), AT_0900_NY);
const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-6, `${got} vs ${want}`);

test('settlement DTE matches the sidecar: PM classes settle at 16:00 New York', () => {
  near(dteOf('20261112', 'SPXW'), 10 + 7 / 24);
  near(dteOf('20261112', 'AAPL'), 10 + 7 / 24);
});

['SPX', 'NDX', 'RUT'].forEach((tradingClass) => {
  test(`settlement DTE: ${tradingClass} settles at 09:30 New York`, () => {
    near(dteOf('20261112', tradingClass), 10 + 0.5 / 24);
  });
});

test('settlement DTE follows New York across the clock change', () => {
  const summer = Date.parse('2026-07-01T13:00:00Z'); // 09:00 EDT
  near(M.settlementDte(contract({ expiry: '20260702' }), summer), 1 + 7 / 24);
  const before = Date.parse('2026-10-31T13:00:00Z'); // 09:00 EDT, clocks go back on Nov 1
  near(M.settlementDte(contract({ expiry: '20261102' }), before), 2 + 8 / 24);
});

test('a reload ages a linked leg from its expiry and touches nothing else', () => {
  const saved = leg({ dte: 40, iv: 22, premium: 5, live: contract({ expiry: '20261112' }) });
  const [out] = M.ageLegs([saved], AT_0900_NY);
  near(out.dte, 10 + 7 / 24);
  assert.deepEqual({ ...out, dte: saved.dte }, saved);
});

test('a leg past its expiry unlinks through the existing rule on reload', () => {
  const saved = leg({ dte: 3, live: contract({ expiry: '20261030' }) });
  const [out] = M.ageLegs([saved], AT_0900_NY);
  assert.equal(out.live, null);
  assert.equal(out.dte, 0);
  assert.equal(M.needsRedraw([saved], [out]), true);
});

test('a leg settling later today is still linked', () => {
  const saved = leg({ dte: 1, live: contract({ expiry: '20261102' }) });
  const [out] = M.ageLegs([saved], AT_0900_NY);
  assert.ok(out.live);
  near(out.dte, 7 / 24);
});

test('a reload leaves manual legs and a damaged link alone', () => {
  const plain = manual({ dte: 40 });
  const damaged = leg({ dte: 40, live: contract({ expiry: 'soon' }) });
  assert.deepEqual(M.ageLegs([plain, damaged], AT_0900_NY), [plain, damaged]);
});

test('helpers never change their inputs', () => {
  const legs = Object.freeze([Object.freeze(leg()), Object.freeze(manual({ id: 2 }))]);
  const quotes = Object.freeze([Object.freeze(quote({ iv: 0.5 }))]);
  assert.doesNotThrow(() => {
    M.refreshLegs(legs, quotes);
    M.ageLegs(legs, NOW);
    M.linkedContracts(legs, 'SPX');
    M.chainTable(quotes);
    M.validRows(quotes);
  });
});

// ---------------------------------------------------------- expiry chosen by date
const picked = (expiry, o = {}) => manual({ dte: 40, listed: { symbol: 'AAPL', expiry, trading_class: 'AAPL' }, ...o });

test('a reload ages an unlinked leg from the date picked for it', () => {
  const [out] = M.ageLegs([picked('20261112')], AT_0900_NY);
  near(out.dte, 10 + 7 / 24);
  assert.deepEqual(out.listed, picked('20261112').listed);
});

test('a picked date that has passed leaves the leg at zero DTE with no date', () => {
  const [out] = M.ageLegs([picked('20261030')], AT_0900_NY);
  assert.equal(out.dte, 0);
  assert.equal(out.listed, null);
});

test('expiry dates read as New York calendar days', () => {
  assert.equal(M.expiryDay('20261106'), 'Fri 6 Nov 26');
  assert.equal(M.expiryDay('20261104'), 'Wed 4 Nov 26');
});

test('the expiry menu marks the leg\'s own date, or Custom when it has none', () => {
  const listed = [{ expiry: '20261104', trading_class: 'AAPL', dte: 2 },
    { expiry: '20261106', trading_class: 'AAPL', dte: 4 }];
  const menu = M.expiryChoices(listed, picked('20261106'), AT_0900_NY);
  assert.deepEqual(menu.map((o) => o.value), ['', '20261104|AAPL', '20261106|AAPL']);
  assert.equal(menu.find((o) => o.selected).value, '20261106|AAPL');
  assert.match(menu[2].text, /^Fri 6 Nov 26 · 4\.3d$/);
  const custom = M.expiryChoices(listed, manual({ dte: 3.3, live: null }), AT_0900_NY);
  assert.equal(custom.find((o) => o.selected).value, '');
  const linkedMenu = M.expiryChoices([{ expiry: '20261120', trading_class: 'SPXW', dte: 18 }], leg(), AT_0900_NY);
  assert.equal(linkedMenu.find((o) => o.selected).value, '20261120|SPXW');
});

test('the expiry menu leaves out a date that has settled since the list loaded', () => {
  const listed = [{ expiry: '20261030', trading_class: 'AAPL', dte: 1 },
    { expiry: '20261106', trading_class: 'AAPL', dte: 4 }];
  const menu = M.expiryChoices(listed, manual({ live: null }), AT_0900_NY);
  assert.deepEqual(menu.map((o) => o.value), ['', '20261106|AAPL']);
});

test('the chain button reads − while the chain is open and + while it is closed', () => {
  const open = M.chainFace(true), shut = M.chainFace(false);
  assert.equal(open.text, '− From chain');
  assert.equal(shut.text, '+ From chain');
  assert.match(open.title, /^Hide the option chain/);
  assert.match(shut.title, /chain/);
  assert.notEqual(open.title, shut.title);
});

test('the analyser reads and sets the shared TWS state through the broker routes', () => {
  assert.equal(M.BROKER.status, '/api/broker/status');
  assert.equal(M.BROKER.connect, '/api/broker/connect');
  const N = require('../../web/shared/nav.js');
  assert.equal(M.BROKER.event, N.BROKER_EVENT);
  assert.equal(M.BROKER.status, N.BROKER.status);
});

test('the analyser ignores only its own broker:changed announcements', () => {
  assert.equal(M.isOwnBrokerEvent({ detail: { source: 'analyser' } }), true);
  assert.equal(M.isOwnBrokerEvent({ detail: { source: 'nav' } }), false);
  assert.equal(M.isOwnBrokerEvent({}), false);
});

test('the analyser never connects on its own: connect is only wired to the button', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../modules/analyser/web/market.js'), 'utf8');
  const calls = src.match(/connectIbkr\b/g) || [];
  assert.equal(calls.length, 2, 'definition + onclick only');
  assert.match(src, /onclick: connectIbkr/);
  assert.doesNotMatch(src, /\/api\/market\/connect|\/api\/market\/status/);
});

test('the analyser shares the busy event with the nav and honours it', () => {
  const N = require('../../web/shared/nav.js');
  assert.equal(M.BROKER.busy, N.BUSY_EVENT);
  const src = require('node:fs').readFileSync(require.resolve('../../modules/analyser/web/market.js'), 'utf8');
  assert.match(src, /if \(M\.connecting \|\| M\.othersBusy\.size\) return;/, 'a press is ignored while another component connects');
  assert.match(src, /setProp\(connectBtn, 'disabled', M\.connecting \|\| M\.othersBusy\.size > 0\)/);
  assert.match(src, /source: 'analyser', busy: on/);
});
