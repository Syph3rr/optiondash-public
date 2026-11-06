'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../static/js/accountpick.js');

// Listed by sort_order, so not by id: the "first IBKR account" is the lowest id, not the first row.
const ACCOUNTS = [
  { id: 2, name: 'Paper', type: 'paper', source: 'journal', broker_ref: null },
  { id: 7, name: 'Roth', type: 'ibkr', source: 'tws', broker_ref: 'U7654321' },
  { id: 1, name: 'IBKR', type: 'ibkr', source: 'tws', broker_ref: 'U1234567' },
  { id: 9, name: 'Crypto', type: 'other', source: 'csv', broker_ref: null },
];

test('the default account is the first IBKR account by lowest id', () => {
  assert.equal(A.defaultAccountId(ACCOUNTS), 1);
  assert.equal(A.defaultAccountId(ACCOUNTS, [1, 2, 7, 9]), 1);
  assert.equal(A.defaultAccountId(ACCOUNTS, [2, 9]), 1);   // two selected: still the IBKR default
});

test('with exactly one account selected, a new trade defaults to it', () => {
  assert.equal(A.defaultAccountId(ACCOUNTS, [2]), 2);
  assert.equal(A.defaultAccountId(ACCOUNTS, [9]), 9);
  assert.equal(A.defaultAccountId(ACCOUNTS, [42]), 1);     // unknown id: ignored
});

test('without an IBKR account the default is the lowest id; no accounts gives null', () => {
  const noIbkr = ACCOUNTS.filter((a) => a.type !== 'ibkr');
  assert.equal(A.defaultAccountId(noIbkr), 2);
  assert.equal(A.defaultAccountId([]), null);
  assert.equal(A.defaultAccountId(null), null);
});

test('fills go to the IBKR account whose broker_ref matches their account number', () => {
  const r = A.accountForFills(ACCOUNTS, [{ account: 'u7654321' }, { account: 'U7654321' }]);
  assert.deepEqual(r, { accountId: 7, number: 'U7654321', matched: true, mixed: false });
});

test('fills with no or an unknown account number go to the default IBKR account', () => {
  assert.deepEqual(A.accountForFills(ACCOUNTS, [{ account: '' }, {}]),
    { accountId: 1, number: '', matched: false, mixed: false });
  assert.deepEqual(A.accountForFills(ACCOUNTS, [{ account: 'U0000001' }]),
    { accountId: 1, number: 'U0000001', matched: false, mixed: false });
});

test('a broker_ref on a non-IBKR account never matches', () => {
  const list = [...ACCOUNTS, { id: 3, name: 'Odd', type: 'other', source: 'csv', broker_ref: 'U5555555' }];
  assert.equal(A.accountForFills(list, [{ account: 'U5555555' }]).accountId, 1);
});

test('fills from two account numbers are flagged as mixed', () => {
  const r = A.accountForFills(ACCOUNTS, [{ account: 'U1234567' }, { account: 'U7654321' }]);
  assert.equal(r.mixed, true);
  assert.equal(r.accountId, null);
});

test('undo moves each trade back to the account it came from, grouped by account', () => {
  const before = [
    { id: 5, account_id: 1 }, { id: 6, account_id: 7 }, { id: 8, account_id: 1 },
    { id: 9, account_id: 2 }, { id: 10, account_id: 9 },
  ];
  const plan = A.undoPlan(before, [5, 6, 8, 9], 2);
  assert.deepEqual(plan, [
    { account_id: 1, trade_ids: [5, 8] },
    { account_id: 7, trade_ids: [6] },
  ]);   // #9 was already in Paper: nothing to undo; #10 was not moved
});

test('undo of nothing is an empty plan', () => {
  assert.deepEqual(A.undoPlan([], [1], 2), []);
  assert.deepEqual(A.undoPlan([{ id: 1, account_id: 2 }], [1], 2), []);
});

test('move message counts trades and names the account', () => {
  assert.equal(A.moveMessage(3, 'Paper'), 'Moved 3 trades to Paper');
  assert.equal(A.moveMessage(1, 'Paper'), 'Moved 1 trade to Paper');
  assert.equal(A.selectedLabel(2), '2 selected');
});

test('account labels: name with the type when the name does not already say it', () => {
  assert.equal(A.typeLabel('ibkr'), 'IBKR');
  assert.equal(A.typeLabel('paper'), 'Paper');
  assert.equal(A.typeLabel('other'), 'Other');
  assert.equal(A.typeLabel('weird'), 'weird');
  assert.equal(A.optionLabel(ACCOUNTS[0]), 'Paper');
  assert.equal(A.optionLabel(ACCOUNTS[1]), 'Roth (IBKR)');
  assert.equal(A.optionLabel(ACCOUNTS[2]), 'IBKR');
  assert.equal(A.optionLabel(ACCOUNTS[3]), 'Crypto (Other)');
});

test('fill destination label says why the account was chosen', () => {
  assert.equal(A.fillDestination(ACCOUNTS, [{ account: 'U7654321' }]), 'Goes to Roth (U7654321)');
  assert.equal(A.fillDestination(ACCOUNTS, [{ account: 'U0000001' }]),
    'Goes to IBKR (default; no account has broker ref U0000001)');
  assert.equal(A.fillDestination(ACCOUNTS, [{}]), 'Goes to IBKR (default)');
  assert.match(A.fillDestination(ACCOUNTS, [{ account: 'U1234567' }, { account: 'U7654321' }]), /two IBKR accounts/);
  assert.equal(A.fillDestination([], [{}]), '');
});

test('selection is pruned to the rows still shown, and select-all reads its state', () => {
  assert.deepEqual([...A.pruneSelection(new Set([1, 2, 3]), [2, 3, 4])], [2, 3]);
  assert.equal(A.selectAllState(new Set(), [1, 2]), 'none');
  assert.equal(A.selectAllState(new Set([1]), [1, 2]), 'some');
  assert.equal(A.selectAllState(new Set([1, 2]), [1, 2]), 'all');
  assert.equal(A.selectAllState(new Set(), []), 'none');
});
