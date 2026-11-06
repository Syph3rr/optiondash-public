'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../../web/shared/widgets.js');

const w = (id, over = {}) => ({ id, title: id.toUpperCase(), mount() {}, ...over });

test('register keeps widgets in registration order by default', () => {
  const r = W.createRegistry();
  r.register(w('a')); r.register(w('b')); r.register(w('c'));
  assert.deepEqual(r.list().map((x) => x.id), ['a', 'b', 'c']);
});

test('order sorts ascending, ties keep registration order, missing order goes last', () => {
  const r = W.createRegistry();
  r.register(w('late', { order: 50 })); r.register(w('none')); r.register(w('early', { order: 10 }));
  r.register(w('tie', { order: 50 }));
  assert.deepEqual(r.list().map((x) => x.id), ['early', 'late', 'tie', 'none']);
});

test('register rejects a widget without id, title or mount', () => {
  const r = W.createRegistry();
  assert.throws(() => r.register({ title: 'x', mount() {} }), /id/);
  assert.throws(() => r.register({ id: 'x', mount() {} }), /title/);
  assert.throws(() => r.register({ id: 'x', title: 'x' }), /mount/);
  assert.throws(() => r.register(null), /widget/);
  assert.equal(r.list().length, 0);
});

test('register rejects a duplicate id and keeps the first', () => {
  const r = W.createRegistry();
  r.register(w('a', { title: 'First' }));
  assert.throws(() => r.register(w('a', { title: 'Second' })), /already/);
  assert.equal(r.list()[0].title, 'First');
});

test('size defaults to 1 and is limited to 1..3 columns', () => {
  const r = W.createRegistry();
  r.register(w('a')); r.register(w('b', { size: 2 })); r.register(w('c', { size: 9 })); r.register(w('d', { size: 0 }));
  assert.deepEqual(r.list().map((x) => x.size), [1, 2, 3, 1]);
});

test('list returns copies so callers cannot change the registry', () => {
  const r = W.createRegistry();
  r.register(w('a'));
  r.list()[0].title = 'hacked';
  assert.equal(r.list()[0].title, 'A');
});

test('safeMount returns ok and passes the element and context to mount', async () => {
  let seen;
  const res = await W.safeMount(w('a', { mount(el, ctx) { seen = [el, ctx]; } }), 'EL', { x: 1 });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(seen, ['EL', { x: 1 }]);
});

test('safeMount catches a throwing widget and reports why, sync or async', async () => {
  const sync = await W.safeMount(w('a', { mount() { throw new Error('boom'); } }), {}, {});
  assert.deepEqual(sync, { ok: false, error: 'boom' });
  const async_ = await W.safeMount(w('b', { async mount() { throw new Error('later'); } }), {}, {});
  assert.deepEqual(async_, { ok: false, error: 'later' });
  const odd = await W.safeMount(w('c', { mount() { throw 'text'; } }), {}, {});
  assert.equal(odd.ok, false);
});

// ---------------------------------------------------------------- Home layout (edit, drag, lock)

const L = W.layout;
const reg = () => [w('a', { size: 1 }), w('b', { size: 2 }), w('c', { size: 3 })].map((x) => ({ ...x, size: x.size }));

test('the default layout is locked, with every card in registry order at its own size', () => {
  assert.deepEqual(L.DEFAULT, { order: [], hidden: [], shown: [], sizes: {}, locked: true });
  const out = L.arrange(reg(), L.DEFAULT);
  assert.deepEqual(out.map((x) => [x.id, x.size, x.hidden]), [['a', 1, false], ['b', 2, false], ['c', 3, false]]);
});

test('arrange follows the saved order; cards it does not know yet go last, unknown ids are ignored', () => {
  const out = L.arrange(reg(), { ...L.DEFAULT, order: ['c', 'gone', 'a'] });
  assert.deepEqual(out.map((x) => x.id), ['c', 'a', 'b']);
});

test('arrange applies saved sizes and hidden cards without changing the widgets', () => {
  const widgets = Object.freeze(reg().map(Object.freeze));
  const out = L.arrange(widgets, { ...L.DEFAULT, hidden: ['b'], sizes: { a: 3 } });
  assert.deepEqual(out.map((x) => [x.id, x.size, x.hidden]), [['a', 3, false], ['b', 2, true], ['c', 3, false]]);
  assert.equal(widgets[0].size, 1);
});

test('edits return new layouts and never change the old one', () => {
  const base = Object.freeze({ ...L.DEFAULT });
  assert.deepEqual(L.withOrder(base, ['b', 'a']).order, ['b', 'a']);
  assert.deepEqual(L.withHidden(base, 'a', true).hidden, ['a']);
  assert.deepEqual(L.withHidden(L.withHidden(base, 'a', true), 'a', false).hidden, []);
  assert.deepEqual(L.withHidden(L.withHidden(base, 'a', true), 'a', true).hidden, ['a']); // no duplicates
  assert.deepEqual(L.withSize(base, 'a', 2).sizes, { a: 2 });
  assert.deepEqual(L.withSize(base, 'a', 9).sizes, { a: 3 }); // clamped to 1..3
  assert.equal(L.withLocked(base, false).locked, false);
  assert.deepEqual(base, L.DEFAULT);
});

test('nextSize cycles 1 -> 2 -> 3 -> 1', () => {
  assert.deepEqual([1, 2, 3].map(L.nextSize), [2, 3, 1]);
});

test('sanitize drops anything malformed', () => {
  assert.deepEqual(L.sanitize(null), L.DEFAULT);
  assert.deepEqual(L.sanitize({ order: 'x', hidden: [1, 'a'], sizes: { a: 2, b: 'big', c: 7 }, locked: 'no' }),
    { order: [], hidden: ['a'], shown: [], sizes: { a: 2, c: 3 }, locked: true });
});

test('read and write survive a broken storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(L.read(storage), L.DEFAULT);
  const saved = L.write(storage, { ...L.DEFAULT, order: ['b'], locked: false });
  assert.deepEqual(L.read(storage), saved);
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(L.read(broken), L.DEFAULT);
  assert.deepEqual(L.write(broken, L.DEFAULT), L.DEFAULT);
});

test('optional cards start hidden and stay shown once added, until hidden again', () => {
  const widgets = [w('a'), { ...w('b'), optional: true }, w('c')];
  const hiddenIds = (layout) => L.arrange(widgets, layout).filter((x) => x.hidden).map((x) => x.id);
  assert.deepEqual(hiddenIds(L.DEFAULT), ['b']);
  const added = L.withHidden(L.DEFAULT, 'b', false);
  assert.deepEqual([added.hidden, added.shown], [[], ['b']]);
  assert.deepEqual(hiddenIds(added), []);
  const removed = L.withHidden(added, 'b', true);
  assert.deepEqual([removed.hidden, removed.shown], [['b'], []]);
  assert.deepEqual(hiddenIds(removed), ['b']);
  assert.deepEqual(hiddenIds(L.withHidden(L.DEFAULT, 'a', true)), ['a', 'b']); // a normal card hides as before
});

test('the saved layout key is versioned so the new default set applies to old layouts', () => {
  assert.equal(L.KEY, 'od.home.layout.v2');
});

// ---------------------------------------------------------------- account filter on Home

test('a widget can opt in to the account filter; the flag is a plain boolean', () => {
  const r = W.createRegistry();
  r.register(w('a', { accounts: true })); r.register(w('b')); r.register(w('c', { accounts: 'yes' }));
  assert.deepEqual(r.list().map((x) => x.accounts), [true, false, true]);
});

test('withQuery adds the filter with the right separator and leaves the URL alone for all accounts', () => {
  assert.equal(W.withQuery('/api/journal/stats', ''), '/api/journal/stats');
  assert.equal(W.withQuery('/api/journal/stats', null), '/api/journal/stats');
  assert.equal(W.withQuery('/api/journal/stats', 'accounts=1,2'), '/api/journal/stats?accounts=1,2');
  assert.equal(W.withQuery('/api/journal/trades?status=open', 'accounts=2'), '/api/journal/trades?status=open&accounts=2');
  assert.equal(W.withQuery('/api/journal/trades?', 'accounts=2'), '/api/journal/trades?accounts=2');
  assert.equal(W.withQuery('/api/journal/trades?a=1&', 'accounts=2'), '/api/journal/trades?a=1&accounts=2');
});

test('withAccounts reads the query from the filter, and treats a missing or broken filter as all accounts', () => {
  assert.equal(W.withAccounts('/api/journal/stats', { query: () => 'accounts=5' }), '/api/journal/stats?accounts=5');
  assert.equal(W.withAccounts('/api/journal/stats', { query: () => '' }), '/api/journal/stats');
  assert.equal(W.withAccounts('/api/journal/stats', undefined), '/api/journal/stats');
  assert.equal(W.withAccounts('/api/journal/stats', { query() { throw new Error('x'); } }), '/api/journal/stats');
  assert.equal(W.withAccounts('/api/journal/stats', {}), '/api/journal/stats');
});

const ACCOUNTS = Object.freeze([
  { id: 1, name: 'IBKR', type: 'ibkr' }, { id: 2, name: 'Paper', type: 'paper' }, { id: 3, name: 'Kraken', type: 'other' },
].map(Object.freeze));

test('accountsNote is empty when every account (or none) is selected, else names what is shown', () => {
  assert.equal(W.accountsNote(ACCOUNTS, [1, 2, 3]), '');
  assert.equal(W.accountsNote(ACCOUNTS, []), '');
  assert.equal(W.accountsNote([], [1]), '');
  assert.equal(W.accountsNote(null, null), '');
  assert.equal(W.accountsNote(ACCOUNTS, [1]), 'Showing IBKR only');
  assert.equal(W.accountsNote(ACCOUNTS, [3, 1]), 'Showing IBKR and Kraken only');
  assert.equal(W.accountsNote(ACCOUNTS, [1, 99]), 'Showing IBKR only'); // unknown ids are ignored
});

test('accountsNote counts instead of naming three or more accounts', () => {
  const five = [...ACCOUNTS, { id: 4, name: 'A', type: 'other' }, { id: 5, name: 'B', type: 'other' }];
  assert.equal(W.accountsNote(five, [1, 2, 3]), 'Showing 3 of 5 accounts');
});

function fakeTimers() {
  let now = 0; let seq = 0; const pending = new Map();
  return {
    set: (fn, ms) => { seq += 1; pending.set(seq, { at: now + ms, fn }); return seq; },
    clear: (id) => { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
    },
  };
}

test('debounce runs once after a burst of calls, with the last arguments', () => {
  const t = fakeTimers(); const calls = [];
  const run = W.debounce((x) => calls.push(x), 200, t.set, t.clear);
  run(1); t.advance(100); run(2); t.advance(100); run(3);
  assert.deepEqual(calls, []);
  t.advance(199);
  assert.deepEqual(calls, []);
  t.advance(1);
  assert.deepEqual(calls, [3]);
  run(4); t.advance(200);
  assert.deepEqual(calls, [3, 4]);
});

test('createSequence: only the newest token is current, per key', () => {
  const s = W.createSequence();
  const a1 = s.next('a');
  assert.equal(s.isCurrent('a', a1), true);
  const a2 = s.next('a');
  const b1 = s.next('b');
  assert.equal(s.isCurrent('a', a1), false);
  assert.equal(s.isCurrent('a', a2), true);
  assert.equal(s.isCurrent('b', b1), true);
  assert.equal(s.isCurrent('c', 1), false);
});

test('createSequence drops a late older result in favour of the newer one', async () => {
  const s = W.createSequence();
  const shown = [];
  const load = async (value, delay) => {
    const token = s.next('card');
    await new Promise((r) => setTimeout(r, delay));
    if (s.isCurrent('card', token)) shown.push(value);
  };
  await Promise.all([load('old selection', 20), load('new selection', 1)]);
  assert.deepEqual(shown, ['new selection']);
});
