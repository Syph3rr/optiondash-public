'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../web/shared/accounts.js');

const ACCOUNTS = [
  { id: 1, name: 'IBKR', type: 'ibkr' },
  { id: 2, name: 'Paper', type: 'paper' },
  { id: 5, name: 'Schwab', type: 'other' },
];

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    data,
  };
}

const throwingStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};

// ---------------------------------------------------------------- pure selection logic

test('the storage key is the documented one', () => {
  assert.equal(A.KEY, 'optiondash.accounts.selected');
});

test('nothing excluded selects every account, in list order', () => {
  assert.deepEqual(A.selectedFrom(ACCOUNTS, []), [1, 2, 5]);
});

test('excluded ids are left out; ids that no longer exist are ignored', () => {
  assert.deepEqual(A.selectedFrom(ACCOUNTS, [2]), [1, 5]);
  assert.deepEqual(A.selectedFrom(ACCOUNTS, [2, 99]), [1, 5]);
});

test('a new account is selected by default because only exclusions are stored', () => {
  const before = ACCOUNTS.slice(0, 2);
  const excluded = A.excludedFrom(before, [1]);
  assert.deepEqual(excluded, [2]);
  assert.deepEqual(A.selectedFrom(ACCOUNTS, excluded), [1, 5]);
});

test('everything excluded falls back to all (at least one is always selected)', () => {
  assert.deepEqual(A.selectedFrom(ACCOUNTS, [1, 2, 5]), [1, 2, 5]);
  assert.deepEqual(A.selectedFrom([], [1]), []);
});

test('excludedFrom ignores unknown selected ids and sorts', () => {
  assert.deepEqual(A.excludedFrom(ACCOUNTS, [5, 42]), [1, 2]);
  assert.deepEqual(A.excludedFrom(ACCOUNTS, [1, 2, 5]), []);
});

test('query is empty when all are selected, else accounts=ids', () => {
  assert.equal(A.queryFor(ACCOUNTS, [1, 2, 5]), '');
  assert.equal(A.queryFor(ACCOUNTS, [5, 1]), 'accounts=1,5');
  assert.equal(A.queryFor(ACCOUNTS, []), '');            // nothing selected never filters to nothing
  assert.equal(A.queryFor([], []), '');
  assert.equal(A.queryFor(ACCOUNTS, [1, 99]), 'accounts=1');
});

test('button label: All, the names when short, else n of m', () => {
  assert.equal(A.labelFor(ACCOUNTS, [1, 2, 5]), 'Accounts: All');
  assert.equal(A.labelFor([], []), 'Accounts: All');
  assert.equal(A.labelFor(ACCOUNTS, [1, 2]), 'Accounts: IBKR, Paper');
  assert.equal(A.labelFor(ACCOUNTS, [5]), 'Accounts: Schwab');
  const many = [...ACCOUNTS, { id: 6, name: 'Fidelity', type: 'other' }];
  assert.equal(A.labelFor(many, [1, 2, 5]), 'Accounts: 3 of 4');
  const long = [{ id: 1, name: 'A very long account name', type: 'other' },
    { id: 2, name: 'Another long one here', type: 'other' }, { id: 3, name: 'C', type: 'paper' }];
  assert.equal(A.labelFor(long, [1, 2]), 'Accounts: 2 of 3');
});

test('readExcluded keeps only positive whole ids and survives junk or a blocked storage', () => {
  assert.deepEqual(A.readExcluded(memoryStorage({ [A.KEY]: '[2, 2, "x", -1, 3.5, 7]' })), [2, 7]);
  assert.deepEqual(A.readExcluded(memoryStorage({ [A.KEY]: '{not json' })), []);
  assert.deepEqual(A.readExcluded(memoryStorage({ [A.KEY]: '{"a":1}' })), []);
  assert.deepEqual(A.readExcluded(memoryStorage()), []);
  assert.deepEqual(A.readExcluded(throwingStorage), []);
  assert.deepEqual(A.readExcluded(null), []);
});

test('writeExcluded stores JSON and never throws', () => {
  const s = memoryStorage();
  A.writeExcluded(s, [3, 1]);
  assert.equal(s.data[A.KEY], '[1,3]');
  assert.doesNotThrow(() => A.writeExcluded(throwingStorage, [1]));
});

// ---------------------------------------------------------------- store (no DOM)

function store(over = {}) {
  const calls = [];
  const target = new EventTarget();
  const storage = over.storage || memoryStorage();
  let list = over.list || ACCOUNTS;
  const s = A.createAccounts({
    storage, target,
    fetchJson: async (url) => { calls.push(url); return list; },
  });
  return { s, calls, target, storage, setList: (l) => { list = l; } };
}

test('load fetches the account list once per page and reload refreshes it', async () => {
  const { s, calls, setList } = store();
  assert.deepEqual(await s.load(), ACCOUNTS);
  await s.load();
  assert.deepEqual(calls, ['/api/journal/accounts']);
  setList(ACCOUNTS.slice(0, 1));
  assert.deepEqual(await s.reload(), ACCOUNTS.slice(0, 1));
  assert.equal(calls.length, 2);
});

test('a failed load is not cached', async () => {
  let fail = true;
  const s = A.createAccounts({
    storage: memoryStorage(), target: new EventTarget(),
    fetchJson: async () => { if (fail) throw new Error('down'); return ACCOUNTS; },
  });
  await assert.rejects(s.load(), /down/);
  fail = false;
  assert.deepEqual(await s.load(), ACCOUNTS);
});

test('default selection is all; setSelected stores exclusions and fires od:accounts', async () => {
  const { s, target, storage } = store();
  const accounts = await s.load();
  assert.deepEqual(s.selected(accounts), [1, 2, 5]);
  assert.equal(s.query(accounts), '');
  const seen = [];
  target.addEventListener('od:accounts', (e) => seen.push(e.detail));
  s.setSelected([2]);
  assert.equal(storage.data[A.KEY], '[1,5]');
  assert.deepEqual(seen, [{ selected: [2] }]);
  assert.deepEqual(s.selected(accounts), [2]);
  assert.deepEqual(s.selected(), [2]);                // the cached list when none is given
  assert.equal(s.query(accounts), 'accounts=2');
});

test('setSelected refuses to select nothing and needs the list', async () => {
  const { s } = store();
  assert.throws(() => s.setSelected([1]), /load/);
  await s.load();
  assert.throws(() => s.setSelected([]), /at least one/);
  assert.throws(() => s.setSelected([99]), /at least one/);
});

test('a change in another tab arrives as od:accounts', async () => {
  const { s, target, storage } = store();
  await s.load();
  const seen = [];
  target.addEventListener('od:accounts', (e) => seen.push(e.detail));
  storage.data[A.KEY] = '[1]';
  const ev = new Event('storage');
  ev.key = A.KEY;
  target.dispatchEvent(ev);
  const other = new Event('storage');
  other.key = 'something.else';
  target.dispatchEvent(other);
  assert.deepEqual(seen, [{ selected: [2, 5] }]);
});

test('changed() reloads the list, stamps storage for other tabs and fires od:accounts', async () => {
  const { s, target, storage, calls, setList } = store();
  await s.load();
  const seen = [];
  target.addEventListener('od:accounts', (e) => seen.push(e.detail));
  setList(ACCOUNTS.slice(0, 2));                     // e.g. account 5 was deleted
  assert.deepEqual(await s.changed(), [1, 2]);
  assert.equal(calls.length, 2);
  assert.ok(storage.data[A.CHANGED_KEY]);
  assert.deepEqual(seen, [{ selected: [1, 2] }]);
});

test('an account change in another tab reloads the list before od:accounts fires', async () => {
  const { s, target, calls, setList } = store();
  await s.load();
  const seen = [];
  target.addEventListener('od:accounts', (e) => seen.push(e.detail));
  setList(ACCOUNTS.slice(0, 1));
  const ev = new Event('storage');
  ev.key = A.CHANGED_KEY;
  target.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, [{ selected: [1] }]);
  assert.deepEqual(await s.load(), ACCOUNTS.slice(0, 1));
});

test('the browser script puts text in only through textContent', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../web/shared/accounts.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
});
