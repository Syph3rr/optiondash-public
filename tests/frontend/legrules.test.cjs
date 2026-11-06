'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../modules/analyser/web/legrules.js');

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};

const LIVE = { symbol: 'SPX', expiry: '20261120', strike: 7580, right: 'C', trading_class: 'SPXW' };
const quote = (o = {}) => deepFreeze({
  symbol: 'SPX', expiry: '20261120', strike: 7580, right: 'C', trading_class: 'SPXW',
  multiplier: 100, dte: 9.5, bid: 1, ask: 2, last: 1.5, mark: 1.5, mark_kind: 'mid',
  delta: 0.5, iv: 0.18, iv_source: 'ibkr', source: 'ibkr', data_type: 'live',
  as_of: '2026-11-02T15:00:00Z', ...o,
});
const linked = (o = {}) => deepFreeze({
  id: 1, enabled: true, kind: 'call', long: true, qty: 3, strike: 7580, dte: 10, iv: 16,
  premium: 99.05, multiplier: 100, live: { ...LIVE }, ivOverride: false, ...o,
});

test('refresh never changes premium, strike or expiry', () => {
  const leg = linked({ premium: 99.05, strike: 7580, iv: 16 });
  const out = R.applyQuote(leg, quote({ iv: 0.18, mark: 120, dte: 9.5 }));
  assert.equal(out.premium, 99.05); assert.equal(out.strike, 7580);
  assert.equal(out.iv, 18); assert.equal(out.dte, 9.5);
});

test('refresh ignores a quote for another contract', () => {
  const leg = linked();
  for (const o of [{ expiry: '20261127' }, { strike: 7585 }, { right: 'P' }, { symbol: 'SPY' }, { trading_class: 'SPX' }]) {
    assert.deepEqual(R.applyQuote(leg, quote(o)), leg);
  }
  assert.deepEqual(R.applyQuote(linked({ live: null }), quote()), linked({ live: null }));
});

test('refresh leaves an overridden IV alone', () => {
  const out = R.applyQuote(linked({ ivOverride: true, iv: 22 }), quote({ iv: 0.18, dte: 8 }));
  assert.equal(out.iv, 22); assert.equal(out.dte, 8); assert.equal(out.ivOverride, true);
});

test('refresh with null iv keeps the old iv', () => {
  assert.equal(R.applyQuote(linked(), quote({ iv: null })).iv, 16);
});

test('refresh with null dte keeps the old dte', () => {
  assert.equal(R.applyQuote(linked(), quote({ dte: null })).dte, 10);
});

test('refresh with no quote keeps every value', () => {
  const leg = linked();
  assert.deepEqual(R.applyQuote(leg, null), leg);
  assert.deepEqual(R.applyQuote(leg, undefined), leg);
  assert.deepEqual(R.applyQuote(leg, quote({ iv: null, dte: null, mark: null })), leg);
});

test('leg past expiry unlinks', () => {
  const out = R.applyQuote(linked(), quote({ dte: 0, iv: 0.3 }));
  assert.equal(out.live, null); assert.equal(out.dte, 0);
  assert.equal(out.iv, 16); assert.equal(out.premium, 99.05); assert.equal(out.strike, 7580);
  assert.equal(R.applyQuote(linked(), quote({ dte: -1 })).live, null);
});

test('IV rounds to 2 decimals in percent', () => {
  assert.equal(R.applyQuote(linked(), quote({ iv: 0.183456 })).iv, 18.35);
});

test('chain pick sets premium to mark and qty 1', () => {
  const leg = R.legFromQuote(quote({ mark: 12.3 }), false);
  assert.equal(leg.premium, 12.3); assert.equal(leg.qty, 1);
  assert.equal(leg.long, false); assert.equal(leg.kind, 'call'); assert.equal(leg.enabled, true);
  assert.equal(leg.strike, 7580); assert.equal(leg.dte, 9.5); assert.equal(leg.iv, 18);
  assert.equal(leg.multiplier, 100); assert.equal(leg.ivOverride, false);
  assert.deepEqual(leg.live, LIVE);
  assert.equal(R.legFromQuote(quote({ right: 'P' }), true).kind, 'put');
  assert.equal(R.legFromQuote(quote({ mark: null }), true).premium, null);
});

test('sync fills a blank premium', () => {
  const out = R.syncLeg(linked({ premium: null, live: null, strike: 1, dte: 1 }), quote({ mark: 4.5 }), 7500);
  assert.equal(out.premium, 4.5); assert.equal(out.strike, 7580); assert.equal(out.dte, 9.5);
  assert.equal(out.iv, 18); assert.deepEqual(out.live, LIVE);
});

test('sync keeps a typed premium and the leg setup', () => {
  const out = R.syncLeg(linked({ long: false, qty: 5, enabled: false }), quote({ mark: 4.5 }), 7500);
  assert.equal(out.premium, 99.05); assert.equal(out.long, false);
  assert.equal(out.qty, 5); assert.equal(out.enabled, false); assert.equal(out.multiplier, 100);
});

test('sync takes the quote multiplier only when it differs and is known', () => {
  assert.equal(R.syncLeg(linked(), quote({ multiplier: 50 }), 1).multiplier, 50);
  assert.equal(R.syncLeg(linked(), quote({ multiplier: null }), 1).multiplier, 100);
});

test('sync fills a blank stock premium with spot', () => {
  const stock = deepFreeze({ id: 2, enabled: true, kind: 'stock', long: true, qty: 10, strike: 0, dte: 0, iv: 0, premium: null, multiplier: 1 });
  const out = R.syncLeg(stock, null, 7512.5);
  assert.equal(out.premium, 7512.5);
  assert.equal(R.syncLeg({ ...stock, premium: 7000 }, quote(), 7512.5).premium, 7000);
  assert.equal(R.syncLeg(stock, quote(), 7512.5).strike, 0);
});

test('editing strike or DTE unlinks', () => {
  assert.equal(R.onEdit(linked(), 'strike').live, null);
  assert.equal(R.onEdit(linked(), 'dte').live, null);
  assert.equal(R.onEdit(linked(), 'qty').live.symbol, 'SPX');
});

test('editing IV overrides but stays linked', () => {
  const out = R.onEdit(linked(), 'iv');
  assert.equal(out.ivOverride, true); assert.deepEqual(out.live, LIVE);
});

test('clearing an override re-enables IV updates', () => {
  const cleared = R.clearIvOverride(linked({ ivOverride: true, iv: 22 }));
  assert.equal(cleared.ivOverride, false);
  assert.equal(R.applyQuote(cleared, quote({ iv: 0.18 })).iv, 18);
});

test('new symbol unlinks legs for the old one', () => {
  const legs = deepFreeze([linked(), linked({ id: 2, live: { ...LIVE, symbol: 'SPY' } }), linked({ id: 3, live: null })]);
  const out = R.unlinkOthers(legs, 'SPY');
  assert.equal(out[0].live, null); assert.equal(out[1].live.symbol, 'SPY'); assert.equal(out[2].live, null);
});

test('moved ignores DTE changes under 0.002 days', () => {
  const a = [linked()];
  assert.equal(R.moved(a, [linked({ dte: 10.001 })]), false);
  assert.equal(R.moved(a, [linked({ dte: 10.002 })]), true);
  assert.equal(R.moved(a, [linked({ iv: 16.005 })]), false);
  assert.equal(R.moved(a, [linked({ iv: 16.01 })]), true);
  assert.equal(R.moved(a, [linked(), linked({ id: 2 })]), true);
  assert.equal(R.moved(a, [linked()]), false);
});

test('poll is 2 s when any quote is live, otherwise 5 s', () => {
  assert.equal(R.nextPollMs([{ data_type: 'delayed' }, { data_type: 'live' }]), 2000);
  assert.equal(R.nextPollMs([{ data_type: 'delayed' }, { data_type: 'yahoo' }]), 5000);
  assert.equal(R.nextPollMs([]), 5000);
});

test('stale after 30 s without an update', () => {
  assert.equal(R.isStale(100000, 129999), false);
  assert.equal(R.isStale(100000, 130001), true);
});

test('inputs are not mutated', () => {
  const leg = linked(); const q = quote(); const legs = [linked(), linked({ id: 2, live: null })];
  const stock = { ...linked(), kind: 'stock' };
  const check = (fn, ...args) => {
    const before = structuredClone(args);
    fn(...args);
    assert.deepEqual(args, before);
  };
  check(R.applyQuote, leg, q); check(R.applyQuote, leg, quote({ dte: 0 }));
  check(R.syncLeg, leg, q, 1); check(R.syncLeg, stock, null, 5);
  check(R.onEdit, leg, 'iv'); check(R.onEdit, leg, 'strike'); check(R.clearIvOverride, leg);
  check(R.unlinkOthers, legs, 'X'); check(R.legFromQuote, q, true); check(R.moved, legs, [leg]);
});

test('refresh never writes premium, even a blank or zero one', () => {
  for (const premium of [null, 0, 99.05]) {
    const out = R.applyQuote(linked({ premium }), quote({ mark: 120 }));
    assert.equal(out.premium, premium);
  }
});

test('refresh never changes the strike of the leg', () => {
  const out = R.applyQuote(linked({ strike: 7000 }), quote());
  assert.equal(out.strike, 7000);
});

test('a refused quote changes nothing, not even iv', () => {
  const leg = linked();
  const out = R.applyQuote(leg, quote({ strike: 1, iv: 0.5, dte: 3 }));
  assert.equal(out, leg);
});

test('moved sees a change in any leg, not just the first', () => {
  const a = [linked(), linked({ id: 2 })];
  assert.equal(R.moved(a, [linked(), linked({ id: 2, iv: 20 })]), true);
  assert.equal(R.moved(a, [linked(), linked({ id: 2, dte: 11 })]), true);
});

test('editing kind unlinks', () => {
  assert.equal(R.onEdit(linked(), 'kind').live, null);
});

test('sync keeps a typed IV and its flag', () => {
  const kept = R.syncLeg(linked({ ivOverride: true, iv: 22 }), quote({ iv: 0.18 }), 1);
  assert.equal(kept.iv, 22); assert.equal(kept.ivOverride, true);
  const taken = R.syncLeg(linked({ ivOverride: false, iv: 22 }), quote({ iv: 0.18 }), 1);
  assert.equal(taken.iv, 18); assert.equal(taken.ivOverride, false);
});

test('sync with an expired quote does not link', () => {
  const leg = linked({ live: null, strike: 1 });
  for (const dte of [0, -2]) assert.equal(R.syncLeg(leg, quote({ dte }), 1), leg);
});

test('an empty string counts as unknown', () => {
  assert.equal(R.legFromQuote(quote({ mark: '' }), true).premium, null);
  assert.equal(R.legFromQuote(quote({ iv: '' }), true).iv, null);
  assert.equal(R.applyQuote(linked(), quote({ iv: '', dte: '' })).iv, 16);
  assert.equal(R.applyQuote(linked(), quote({ iv: '', dte: '' })).dte, 10);
});

// ---------------------------------------------------------- expiry chosen by date
const NOV6 = deepFreeze({ expiry: '20261106', trading_class: 'AAPL', dte: 4.26 });

test('picking an expiry by date sets its DTE and remembers the date', () => {
  const out = R.pickExpiry(linked({ live: null, dte: 3.3 }), NOV6, 'AAPL', 4.25);
  assert.equal(out.dte, 4.25);
  assert.deepEqual(out.listed, { symbol: 'AAPL', expiry: '20261106', trading_class: 'AAPL' });
});

test('picking another date unlinks the leg; picking its own date keeps the link', () => {
  assert.equal(R.pickExpiry(linked(), NOV6, 'SPX', 4.25).live, null);
  const own = { expiry: '20261120', trading_class: 'SPXW', dte: 9.5 };
  assert.deepEqual(R.pickExpiry(linked(), own, 'SPX', 9.5).live, LIVE);
});

test('a typed DTE forgets the date; a typed strike or kind keeps it', () => {
  const picked = R.pickExpiry(linked({ live: null }), NOV6, 'AAPL', 4.25);
  assert.equal(R.onEdit(picked, 'dte').listed, null);
  assert.deepEqual(R.onEdit(picked, 'strike').listed, picked.listed);
  assert.deepEqual(R.onEdit(picked, 'kind').listed, picked.listed);
});

test('unlinking by a typed strike keeps the date of the contract it was on', () => {
  assert.deepEqual(R.onEdit(linked(), 'strike').listed,
    { symbol: 'SPX', expiry: '20261120', trading_class: 'SPXW' });
});

test('a new symbol forgets dates picked for another symbol', () => {
  const picked = R.pickExpiry(linked({ live: null }), NOV6, 'AAPL', 4.25);
  assert.equal(R.unlinkOthers([picked], 'SPY')[0].listed, null);
  assert.deepEqual(R.unlinkOthers([picked], 'AAPL')[0].listed, picked.listed);
});

test('picking an expiry never changes its inputs', () => {
  assert.doesNotThrow(() => R.pickExpiry(linked(), NOV6, 'AAPL', 4.25));
});

test('linking puts the date on the linked contract, so the two never disagree', () => {
  const picked = R.pickExpiry(linked({ live: null }), NOV6, 'SPX', 4.25);
  const out = R.syncLeg(picked, quote());
  assert.deepEqual(out.listed, { symbol: 'SPX', expiry: '20261120', trading_class: 'SPXW' });
  assert.deepEqual(R.legFromQuote(quote(), true).listed, out.listed);
});

test('an edit keeps the date of the linked contract over an older pick', () => {
  const stale = linked({ listed: { symbol: 'SPX', expiry: '20261106', trading_class: 'SPXW' } });
  assert.equal(R.onEdit(stale, 'strike').listed.expiry, '20261120');
});

test('an expired contract takes its date with it, and a stock leg has none', () => {
  const out = R.applyQuote(linked({ listed: { symbol: 'SPX', expiry: '20261120', trading_class: 'SPXW' } }),
    quote({ dte: 0 }));
  assert.equal(out.listed, null);
  assert.equal(R.onEdit(linked({ kind: 'stock' }), 'kind').listed, null);
});
