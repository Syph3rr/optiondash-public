'use strict';
// Portfolio per account: which rows each account shows, the TWS split between IBKR accounts,
// the per-account TWS saves and the data gathering shared by the page and the Home card.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../modules/portfolio/web/portfolio.js');

const acc = (id, name, type, source, broker_ref = null, snapshot = null) =>
  ({ id, name, type, source, broker_ref, sort_order: id, trades: 0, open_trades: 0, snapshot });
const ibkr = acc(1, 'IBKR', 'ibkr', 'tws');
const roth = acc(5, 'Roth', 'ibkr', 'tws', 'U222');
const main = acc(3, 'Main', 'ibkr', 'tws', 'u111');
const paper = acc(2, 'Paper', 'paper', 'journal');
const schwab = acc(4, 'Schwab', 'other', 'csv');
const tasty = acc(6, 'Tasty', 'other', 'journal');

const row = (symbol, account, qty = 1) => ({ symbol, sec_type: 'STK', kind: 'stock', strike: null, expiry: null,
  multiplier: 1, qty, avg_cost: 10, account });
const legOf = (q) => ({ kind: 'stock', strike: null, expiry: null, multiplier: 1, net_qty: q, avg_cost: 10 });
const tr = (id, account_id, status = 'open') => ({ id, underlying: 'AAPL', strategy: 'stock', status, account_id, legs: [legOf(5)] });

test('brokerAccountFor matches broker_ref case-insensitively, else the lowest-id IBKR account', () => {
  const list = [roth, paper, main, ibkr];
  assert.equal(P.brokerAccountFor(list, 'U111'), 3);
  assert.equal(P.brokerAccountFor(list, 'u222'), 5);
  assert.equal(P.brokerAccountFor(list, 'U999'), 1);
  assert.equal(P.brokerAccountFor(list, ''), 1);
  assert.equal(P.brokerAccountFor([paper], 'U1'), null);
});

test('splitByBroker gives every IBKR account its rows (possibly none)', () => {
  const split = P.splitByBroker([main, ibkr, paper, roth], [row('A', 'U111'), row('B', 'U222'), row('C', 'DU5'), row('D', undefined)]);
  assert.deepEqual(Object.keys(split).sort(), ['1', '3', '5']);
  assert.deepEqual(split[3].map((r) => r.symbol), ['A']);
  assert.deepEqual(split[5].map((r) => r.symbol), ['B']);
  assert.deepEqual(split[1].map((r) => r.symbol), ['C', 'D']);
  assert.deepEqual(P.splitByBroker([main], null), { 3: [] });
});

test('twsSaves: accounts that got rows or cash, plus the fallback account; cash left out when unread', () => {
  const pos = [row('A', 'U111'), row('C', 'DU5')];
  const cash = [{ account: 'U222', currency: 'USD', cash: 5 }];
  const saves = P.twsSaves([ibkr, main, roth, paper, acc(7, 'Gone', 'ibkr', 'tws', 'U777')], pos, cash);
  assert.deepEqual(saves.map((s) => s.id), [1, 3, 5], 'U777 is not in TWS, so its saved copy is left alone');
  assert.deepEqual(saves.find((s) => s.id === 5), { id: 5, positions: [], accounts: cash });
  assert.deepEqual(saves.find((s) => s.id === 3).accounts, []);
  const noCash = P.twsSaves([ibkr], [], null);
  assert.deepEqual(noCash, [{ id: 1, positions: [] }], 'the fallback is saved even when flat; no cash key keeps the saved cash');
  assert.deepEqual(P.twsSaves([paper], [row('A', 'U1')], null), []);
});

test('accountRows: IBKR shows TWS rows when TWS answered', () => {
  const r = P.accountRows({ account: ibkr, twsRows: [row('A', 'U1')], twsCash: [{ account: 'U1', cash: 1 }], snapshot: null, journalTrades: [tr(1, 1)] });
  assert.deepEqual([r.source, r.sourceLabel, r.brokerSourced, r.rows.length, r.cash.length], ['tws', 'TWS live', true, 1, 1]);
  assert.deepEqual(r.trades.map((t) => t.id), [1]);
});

test('accountRows: IBKR falls back to its snapshot, else nothing', () => {
  const snap = { source: 'tws', saved_at: '2026-11-06T10:53:00', positions: [row('A', 'U1')], accounts: [{ cash: 2 }] };
  const r = P.accountRows({ account: ibkr, twsRows: null, snapshot: snap, journalTrades: [] });
  assert.deepEqual([r.source, r.sourceLabel, r.rows.length, r.cash.length], ['saved', `Saved ${P.savedWhen(snap.saved_at)}`, 1, 1]);
  const csv = P.accountRows({ account: ibkr, twsRows: null, snapshot: { ...snap, source: 'csv' }, journalTrades: [] });
  assert.deepEqual([csv.source, csv.sourceLabel], ['csv', `CSV ${P.savedWhen(snap.saved_at)}`]);
  const none = P.accountRows({ account: ibkr, twsRows: null, snapshot: null, journalTrades: [tr(1, 1)] });
  assert.deepEqual([none.source, none.sourceLabel, none.rows, none.cash, none.brokerSourced], ['none', 'Nothing saved', [], [], true]);
});

test('accountRows: Other with a CSV source shows its snapshot', () => {
  const snap = { source: 'csv', saved_at: '2026-11-06T10:53:00', positions: [row('S', '')], accounts: [] };
  const r = P.accountRows({ account: schwab, twsRows: [row('X', 'U1')], snapshot: snap, journalTrades: [] });
  assert.deepEqual([r.source, r.rows.map((x) => x.symbol), r.brokerSourced], ['csv', ['S'], true]);
});

test('accountRows: Paper and Other/journal use their own open trades', () => {
  const trades = [tr(1, 2), tr(2, 2, 'closed'), tr(3, 6), tr(4, 1)];
  const p = P.accountRows({ account: paper, twsRows: [row('X', 'U1')], snapshot: null, journalTrades: trades });
  assert.deepEqual([p.source, p.sourceLabel, p.brokerSourced, p.rows.map((x) => x.trade_id), p.trades.map((t) => t.id)],
    ['journal', 'Journal', false, [1], [1]]);
  const t = P.accountRows({ account: tasty, twsRows: null, snapshot: null, journalTrades: trades });
  assert.deepEqual(t.rows.map((x) => x.trade_id), [3]);
});

// ------------------------------------------------------------ gather

function fakeServer(routes) {
  const calls = [];
  let active = 0;
  let maxBroker = 0;
  const request = async (url) => {
    calls.push(url);
    const broker = url.startsWith('/api/broker/');
    if (broker) { active += 1; maxBroker = Math.max(maxBroker, active); }
    await new Promise((r) => setTimeout(r, 1));
    if (broker) active -= 1;
    const hit = routes[url];
    return hit ? { status: hit[0], body: hit[1] } : { status: 404, body: { ok: false, error: 'nope' } };
  };
  return { request, calls, maxBroker: () => maxBroker };
}

test('gather: TWS live, rows split by account, cash read after positions, trades for the selection', async () => {
  const s = fakeServer({
    '/api/journal/trades?accounts=1,2': [200, { ok: true, data: [tr(9, 1), tr(10, 2)] }],
    '/api/broker/positions': [200, { positions: [row('A', 'U1'), row('B', 'U222')], as_of: 'now' }],
    '/api/broker/account': [200, { accounts: [{ account: 'U1', currency: 'USD', cash: 7 }] }],
  });
  const out = await P.gather({ accounts: [ibkr, paper, roth], selected: [1, 2], request: s.request });
  assert.deepEqual(out.shown.map((a) => [a.account.id, a.source, a.rows.length]), [[1, 'tws', 1], [2, 'journal', 1]]);
  assert.deepEqual(out.shown[0].cash.map((c) => c.cash), [7]);
  assert.equal(out.tws.state, 'live');
  assert.equal(out.tws.positions.length, 2, 'every TWS row is kept for the per-account saves');
  assert.equal(s.maxBroker(), 1, 'never two broker reads at once');
  assert.ok(s.calls.indexOf('/api/broker/account') > s.calls.indexOf('/api/broker/positions'));
});

test('gather: TWS off reads only the snapshots that exist; no TWS read without an IBKR account shown', async () => {
  const snap = { source: 'csv', saved_at: '2026-11-06T10:00:00', positions: [row('A', '')], accounts: [] };
  const s = fakeServer({
    '/api/journal/trades': [200, { ok: true, data: [] }],
    '/api/broker/positions': [409, { error: 'not connected' }],
    '/api/journal/accounts/4/snapshot': [200, { ok: true, data: snap }],
  });
  const withSnap = { ...schwab, snapshot: { source: 'csv', saved_at: 'x', positions: 1 } };
  const out = await P.gather({ accounts: [ibkr, withSnap], selected: [1, 4], request: s.request });
  assert.equal(out.tws.state, 'offline');
  assert.deepEqual(out.shown.map((a) => a.source), ['none', 'csv']);
  assert.ok(!s.calls.includes('/api/journal/accounts/1/snapshot'), 'no snapshot saved, so none is read');
  assert.ok(!s.calls.includes('/api/broker/account'));

  const s2 = fakeServer({ '/api/journal/trades?accounts=2': [200, { ok: true, data: [] }] });
  const out2 = await P.gather({ accounts: [ibkr, paper], selected: [2], request: s2.request });
  assert.equal(out2.tws.state, 'skipped');
  assert.ok(!s2.calls.some((u) => u.startsWith('/api/broker/')));
});

test('gather: a TWS failure other than 409 keeps its message; a journal failure is reported', async () => {
  const s = fakeServer({ '/api/broker/positions': [502, { error: 'sidecar down' }] });
  const out = await P.gather({ accounts: [ibkr], selected: [1], request: s.request });
  assert.deepEqual([out.tws.state, out.tws.error], ['failed', 'sidecar down']);
  assert.equal(out.journalError, 'nope');
  assert.deepEqual(out.shown[0].rows, []);
});

test('gather: unknown or empty selection shows every account', async () => {
  const s = fakeServer({ '/api/journal/trades': [200, { ok: true, data: [] }] });
  const out = await P.gather({ accounts: [paper, tasty], selected: [], request: s.request });
  assert.deepEqual(out.shown.map((a) => a.account.id), [2, 6]);
});

test('cashState explains missing cash by where the accounts get it', () => {
  const summary = { currency: 'USD', cash: 1, otherCurrencies: [] };
  const shown = (source, type = 'ibkr') => [{ source, account: { type } }];
  assert.deepEqual(P.cashState({ tws: { state: 'live', cash: [] }, shown: shown('tws') }, summary),
    { summary, reason: '', missing: 'TWS sent no cash figures' });
  assert.equal(P.cashState({ tws: { state: 'offline' }, shown: shown('csv') }, summary).missing, 'not saved');
  const reason = (tws, s) => P.cashState({ tws, shown: s }, null).reason;
  assert.equal(reason({ state: 'offline' }, shown('none')), 'not connected to TWS');
  assert.equal(reason({ state: 'failed' }, shown('none')), 'unavailable');
  assert.equal(reason({ state: 'live', cash: null }, shown('tws')), 'unavailable');
  assert.equal(reason({ state: 'live', cash: [] }, shown('tws')), 'TWS sent no cash figures');
  assert.equal(reason({ state: 'skipped' }, shown('journal', 'paper')), 'no cash for these accounts');
  assert.equal(reason({ state: 'offline' }, shown('csv', 'other').concat(shown('saved'))), 'not saved');
});

test('the Home card names each shown account with its source in one short line', () => {
  global.Portfolio = P;
  const W = require('../../modules/portfolio/web/widgets.js');
  const v = (name, sourceLabel) => ({ account: { name }, sourceLabel });
  assert.equal(W.sourcesNote([v('IBKR', 'TWS live'), v('Paper', 'Journal')]), 'IBKR: TWS live · Paper: Journal');
  assert.equal(W.sourcesNote([]), '');
  assert.equal(W.sourcesNote([v('A', 'x'), v('B', 'y'), v('C', 'z'), v('D', 'w')]), 'A: x · B: y · C: z · +1 more');
});

test('totalsOf adds rows across accounts and combines cash like accountSummary', () => {
  const shown = [{ rows: [row('A', 'U1', 2)], cash: [{ currency: 'USD', cash: 5, net_liquidation: 10 }] },
    { rows: [row('B', '', -1)], cash: [{ currency: 'USD', cash: 1, net_liquidation: 2 }] }, { rows: [], cash: [] }];
  const t = P.totalsOf(shown);
  assert.deepEqual([t.summary.totals.positions, t.summary.totals.net, t.summary.byUnderlying.length], [2, 10, 2]);
  assert.equal(t.cash.cash, 6);
  assert.equal(P.totalsOf([{ rows: [], cash: [] }]).cash, null);
});
