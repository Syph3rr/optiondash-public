'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../../modules/_template/web');
const T = require(path.join(dir, 'NAME.js'));

test('template helper copies rows and never changes its input', () => {
  const rows = Object.freeze([Object.freeze({ a: 1 })]);
  const s = T.summarise(rows);
  assert.equal(s.total, 1);
  assert.notEqual(s.rows[0], rows[0]);
  assert.deepEqual(T.summarise(null), { rows: [], total: 0 });
});

test('template page loads only the files the template ships', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\/NAME\/static\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3);
  for (const f of refs) assert.ok(fs.existsSync(path.join(dir, f)), `${f} missing from the template`);
});
