'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../modules/settings/web/accountscard.js');

const ACCOUNTS = [
  { id: 1, name: 'IBKR', type: 'ibkr', source: 'tws', broker_ref: 'U1234567', sort_order: 0, trades: 5, open_trades: 2 },
  { id: 2, name: 'Paper', type: 'paper', source: 'journal', broker_ref: null, sort_order: 1, trades: 1, open_trades: 0 },
  { id: 4, name: 'Crypto', type: 'other', source: 'csv', broker_ref: null, sort_order: 2, trades: 0, open_trades: 0 },
];

test('source choices follow the server pairs; only Other has a choice', () => {
  assert.deepEqual(S.sourceChoices('ibkr'), ['tws']);
  assert.deepEqual(S.sourceChoices('paper'), ['journal']);
  assert.deepEqual(S.sourceChoices('other'), ['csv', 'journal']);
  assert.deepEqual(S.sourceChoices('nope'), []);
  assert.equal(S.sourceLabel('tws'), 'TWS');
  assert.equal(S.sourceLabel('csv'), 'CSV');
  assert.equal(S.sourceLabel('journal'), 'Journal');
});

test('trade counts read naturally', () => {
  assert.equal(S.countsLabel(ACCOUNTS[0]), '2 open · 5 trades');
  assert.equal(S.countsLabel(ACCOUNTS[1]), '0 open · 1 trade');
  assert.equal(S.countsLabel(ACCOUNTS[2]), 'No trades');
});

test('names: 1-40 characters, unique ignoring case (except the account itself)', () => {
  assert.equal(S.checkName('  ', ACCOUNTS), 'Give the account a name.');
  assert.equal(S.checkName('x'.repeat(41), ACCOUNTS), 'Names are at most 40 characters.');
  assert.equal(S.checkName('paper', ACCOUNTS), 'There is already an account called Paper.');
  assert.equal(S.checkName('paper', ACCOUNTS, 2), '');
  assert.equal(S.checkName(' Roth ', ACCOUNTS), '');
});

test('broker ref is optional, upper-cased and checked like the server', () => {
  assert.deepEqual(S.normaliseBrokerRef(''), { value: null, error: '' });
  assert.deepEqual(S.normaliseBrokerRef('  u1234567 '), { value: 'U1234567', error: '' });
  assert.match(S.normaliseBrokerRef('U12 34').error, /letters, digits/);
  assert.match(S.normaliseBrokerRef('x'.repeat(33)).error, /letters, digits/);
});

test('moving an account up or down renumbers sort_order and lists only the changes', () => {
  assert.deepEqual(S.reorderPlan(ACCOUNTS, 2, -1), [{ id: 2, sort_order: 0 }, { id: 1, sort_order: 1 }]);
  assert.deepEqual(S.reorderPlan(ACCOUNTS, 2, 1), [{ id: 4, sort_order: 1 }, { id: 2, sort_order: 2 }]);
  assert.deepEqual(S.reorderPlan(ACCOUNTS, 1, -1), []);   // already first
  assert.deepEqual(S.reorderPlan(ACCOUNTS, 4, 1), []);    // already last
  assert.deepEqual(S.reorderPlan(ACCOUNTS, 9, 1), []);
});

test('reordering fixes duplicate sort_order values left from before', () => {
  const same = ACCOUNTS.map((a) => ({ ...a, sort_order: 0 }));
  assert.deepEqual(S.reorderPlan(same, 4, -1),
    [{ id: 4, sort_order: 1 }, { id: 2, sort_order: 2 }]);
});

test('delete: the accounts trades can move to are all the others', () => {
  assert.deepEqual(S.moveTargets(ACCOUNTS, 1).map((a) => a.id), [2, 4]);
  assert.equal(S.deleteQuestion(ACCOUNTS[0]), 'Move its 5 trades to');
  assert.equal(S.deleteQuestion(ACCOUNTS[1]), 'Move its 1 trade to');
  assert.equal(S.deleteQuestion(ACCOUNTS[2]), 'Delete Crypto?');
});

test('the card puts server text in only through textContent', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../modules/settings/web/accountscard.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|confirm\(/.test(src));
});

test('an account row never appends a missing cell as the text "null"', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../modules/settings/web/accountscard.js'), 'utf8');
  const rowFn = src.slice(src.indexOf('function row('), src.indexOf('function render('));
  assert.match(rowFn, /\.filter\(Boolean\)/, 'row() must drop null cells before the native append');
});
