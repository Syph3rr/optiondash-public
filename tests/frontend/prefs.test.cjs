'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../../web/shared/nav.js');
const P = N.prefs;

test('defaults: follow the system theme, 4% rate, 1.3% dividend yield', () => {
  assert.deepEqual(P.DEFAULTS, { theme: 'system', rate: 4, divYield: 1.3 });
  assert.deepEqual(P.sanitize(null), P.DEFAULTS);
  assert.deepEqual(P.sanitize('not json'), P.DEFAULTS);
});

test('sanitize keeps valid values and drops bad ones field by field', () => {
  assert.deepEqual(P.sanitize({ theme: 'light', rate: 5.25, divYield: 0 }), { theme: 'light', rate: 5.25, divYield: 0 });
  assert.deepEqual(P.sanitize({ theme: 'purple', rate: 'x', divYield: -1 }), P.DEFAULTS);
  assert.deepEqual(P.sanitize({ rate: 99 }), P.DEFAULTS); // out of range
  assert.deepEqual(P.sanitize({ theme: 'dark', extra: 1 }), { ...P.DEFAULTS, theme: 'dark' });
});

test('sanitize never changes its input', () => {
  const raw = Object.freeze({ theme: 'light', rate: 3 });
  P.sanitize(raw);
  assert.deepEqual(raw, { theme: 'light', rate: 3 });
});

test('resolveTheme turns the preference into the theme to show', () => {
  assert.equal(P.resolveTheme('dark', true), 'dark');
  assert.equal(P.resolveTheme('light', false), 'light');
  assert.equal(P.resolveTheme('system', true), 'light');
  assert.equal(P.resolveTheme('system', false), 'dark');
  assert.equal(P.resolveTheme('nonsense', true), 'light'); // bad input falls back to system
});

test('read and write go through storage, and a broken storage never throws', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(P.read(storage), P.DEFAULTS);
  const next = P.write(storage, { theme: 'light' });
  assert.deepEqual(next, { ...P.DEFAULTS, theme: 'light' });
  assert.deepEqual(P.read(storage), next);
  assert.deepEqual(P.write(storage, { rate: 5 }), { ...next, rate: 5 });
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(P.read(broken), P.DEFAULTS);
  assert.deepEqual(P.write(broken, { theme: 'dark' }), { ...P.DEFAULTS, theme: 'dark' });
});
