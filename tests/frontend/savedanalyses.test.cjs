'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../../modules/analyser/web/savedanalyses.js');

const contract = { symbol: 'SPY', expiry: '20261218', strike: 540, right: 'P', trading_class: 'SPY' };
const S = {
  symbol: 'SPY', spot: 552.5, model: 'american', rate: 4.25, divy: 1.1, pdte: 21, ivShift: -1.5,
  range: 8, rangeAuto: false, view: 'heat', tSel: 1793000000000, priceSource: 'live',
  liveOn: true, loadedSymbol: 'SPY', tPin: 2,
  entry: { date: '2026-11-02', spot: 550, iv: 20 },
  legs: [
    { id: 4, enabled: true, kind: 'put', long: false, qty: 2, strike: 540, dte: 43.2, iv: 21.4,
      premium: 2.6, fill: 3.0, multiplier: 100, live: contract,
      listed: { symbol: 'SPY', expiry: '20261218', trading_class: 'SPY' }, ivOverride: true },
    { id: 5, enabled: false, kind: 'stock', long: true, qty: 100, strike: 0, dte: 0, iv: 18,
      premium: null, multiplier: 1, live: null, listed: null, ivOverride: false },
  ],
};

test('serialise: versioned, no ids, pins or live-feed state, every leg field kept', () => {
  const blob = A.serialise(S);
  assert.equal(blob.v, 1);
  assert.equal(blob.liveOn, undefined);
  assert.equal(blob.loadedSymbol, undefined);
  assert.equal(blob.tPin, undefined);
  assert.equal(blob.legs[0].id, undefined);
  assert.equal(blob.legs[0].fill, 3);
  assert.equal(blob.legs[1].fill, null);
  assert.deepEqual(blob.entry, S.entry);
  assert.equal(blob.priceSource, 'live');
  assert.notEqual(blob.legs[0].live, S.legs[0].live, 'copies, never shares');
});

test('round trip restores the state exactly', () => {
  const { state, dropped } = A.restore(JSON.parse(JSON.stringify(A.serialise(S))));
  assert.equal(dropped, 0);
  const { liveOn, loadedSymbol, tPin, ...rest } = S;
  const legs = S.legs.map(({ id, ...l }) => ({ fill: null, ...l }));
  assert.deepEqual(state, { ...rest, legs });
});

test('missing fields fall back to the defaults', () => {
  const { state } = A.restore({ v: 1 });
  assert.deepEqual(state.legs, []);
  assert.deepEqual(state.entry, { date: null, spot: null, iv: null });
  Object.entries(A.DEFAULTS).forEach(([k, v]) => assert.deepEqual(state[k], v, k));
});

test('a blob without a version is read as v1', () => {
  assert.equal(A.restore({ symbol: 'QQQ' }).state.symbol, 'QQQ');
});

test('a newer version or a non-object is refused', () => {
  assert.throws(() => A.restore({ v: 2 }), /newer version/);
  assert.throws(() => A.restore(null), /not readable/);
  assert.throws(() => A.restore([1]), /not readable/);
});

test('damaged fields are replaced, never passed through', () => {
  const { state } = A.restore({ v: 1, symbol: '<img src=x onerror=alert(1)>', spot: -5, model: 'quantum',
    view: 'nope', ivShift: 99, range: 0, tSel: 'soon', rate: 'x', priceSource: 'magic',
    entry: { date: '5/11/2026', spot: 0, iv: '20' } });
  assert.equal(state.symbol, 'SPX');
  assert.equal(state.spot, 5800);
  assert.equal(state.model, 'european');
  assert.equal(state.view, 'payoff');
  assert.equal(state.ivShift, 0);
  assert.equal(state.range, 15);
  assert.equal(state.tSel, null);
  assert.equal(state.rate, 4);
  assert.equal(state.priceSource, 'manual');
  assert.deepEqual(state.entry, { date: null, spot: null, iv: null });
});

test('legs: bad ones dropped and counted, text in numeric fields never survives', () => {
  const { state, dropped } = A.restore({ v: 1, legs: [
    { kind: 'call', long: true, qty: 1, strike: '"><script>', dte: 30, iv: 18, multiplier: 100 },
    { kind: 'swap', qty: 1, multiplier: 1 },
    'junk',
    { kind: 'call', long: true, qty: 1, strike: 600, dte: 30, iv: 18, multiplier: 100,
      premium: '1.5', fill: -2, live: { ...contract, expiry: '2026-12-18' }, listed: { symbol: 'SPY' }, extra: 'x' },
  ] });
  assert.equal(dropped, 3);
  assert.equal(state.legs.length, 1);
  const [l] = state.legs;
  assert.equal(l.premium, null);
  assert.equal(l.fill, null);
  assert.equal(l.live, null);
  assert.equal(l.listed, null);
  assert.equal(l.extra, undefined);
  assert.equal(l.enabled, true);
});

test('stock legs keep no strike, DTE or contract', () => {
  const { state } = A.restore({ legs: [{ kind: 'stock', long: false, qty: 100, multiplier: 1, strike: 5,
    dte: 9, live: contract, fill: 101.5 }] });
  assert.deepEqual(state.legs[0], { enabled: true, kind: 'stock', long: false, qty: 100, strike: 0, dte: 0,
    iv: 18, premium: null, fill: 101.5, multiplier: 1, live: null, listed: null, ivOverride: false });
});

test('names: trimmed 1 to 80 characters, no control characters', () => {
  assert.equal(A.nameProblem('  ok  '), null);
  assert.match(A.nameProblem('   '), /name/);
  assert.match(A.nameProblem('x'.repeat(81)), /80/);
  assert.equal(A.nameProblem('x'.repeat(80)), null);
  assert.match(A.nameProblem('a\tb'), /control/);
  assert.match(A.nameProblem(null), /name/);
});

test('suggestName uses the symbol and the New York date', () => {
  // 2026-11-06 03:00 UTC is still 5 Nov in New York
  assert.equal(A.suggestName({ symbol: 'spy' }, Date.UTC(2026, 10, 6, 3, 0)), 'SPY 5 Nov 2026');
});

test('optionText: name, underlying and day', () => {
  assert.equal(A.optionText({ name: 'Condor', underlying: 'SPX', updated_at: '2026-11-05T01:02:03+00:00' }),
    'Condor · SPX · 2026-11-05');
  assert.equal(A.optionText({ name: 'Bare', underlying: null }), 'Bare');
});

// ---------------------------------------------------------------- api
function fakeFetch(replies) {
  const calls = [];
  const fn = async (path, init) => {
    calls.push({ path, init });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { fn, calls };
}

test('api: list, get, create, update, remove send the right requests', async () => {
  const ok = (data, status = 200) => ({ status, body: { ok: true, data, error: null } });
  const f = fakeFetch([ok([]), ok({ id: 3 }), ok({ id: 4 }, 201), ok({ id: 4 }), ok({ deleted: 4 })]);
  const api = A.api(f.fn);
  assert.deepEqual(await api.list(), []);
  assert.deepEqual(await api.get(3), { id: 3 });
  await api.create('  Name ', { v: 1 });
  await api.update(4, 'New', { v: 1 });
  await api.remove(4);
  assert.deepEqual(f.calls.map((c) => [c.init.method, c.path]), [
    ['GET', A.BASE], ['GET', `${A.BASE}/3`], ['POST', A.BASE], ['PUT', `${A.BASE}/4`], ['DELETE', `${A.BASE}/4`]]);
  assert.deepEqual(JSON.parse(f.calls[2].init.body), { name: 'Name', state: { v: 1 } });
  assert.equal(f.calls[2].init.headers['content-type'], 'application/json');
  assert.equal(f.calls[0].init.body, undefined);
});

test('api: server errors, offline journal and network failures become readable errors', async () => {
  const f = fakeFetch([
    { status: 422, body: { ok: false, data: null, error: 'name: too long' } },
    { status: 503, body: null },
    new TypeError('Failed to fetch'),
    { status: 500, body: null },
  ]);
  const api = A.api(f.fn);
  await assert.rejects(api.create('x', {}), /too long/);
  await assert.rejects(api.list(), /journal is offline/);
  await assert.rejects(api.list(), /not reachable/);
  await assert.rejects(api.list(), /500/);
});

test('api: a bad id never reaches the network', async () => {
  const f = fakeFetch([]);
  const api = A.api(f.fn);
  await assert.rejects(api.get('1/../x'), /no saved analysis/);
  await assert.rejects(api.remove(0), /no saved analysis/);
  assert.equal(f.calls.length, 0);
});
