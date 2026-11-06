'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../static/js/panels.js');

const NEW = P.PANELS.find((p) => p.id === 'new-trade');
const IMPORT = P.PANELS.find((p) => p.id === 'ibkr-import');

test('the Trades page has a New trade panel and an IBKR import panel', () => {
  assert.ok(NEW && IMPORT);
  assert.deepEqual(P.PANELS.map((p) => p.param), ['new', 'import']);
});

test('New trade opens for ?new and for the analyser hand-off', () => {
  assert.equal(P.wantsOpen(NEW, '?new=1'), true);
  assert.equal(P.wantsOpen(NEW, '?new'), true);
  assert.equal(P.wantsOpen(NEW, '?from=analyser'), true);
  assert.equal(P.wantsOpen(NEW, '?from=analyzer'), true); // old spelling
  assert.equal(P.wantsOpen(NEW, ''), false);
  assert.equal(P.wantsOpen(NEW, undefined), false);
  assert.equal(P.wantsOpen(NEW, '?from=somewhere'), false);
  assert.equal(P.wantsOpen(NEW, '?import=1'), false);
});

test('IBKR import opens for ?import only', () => {
  assert.equal(P.wantsOpen(IMPORT, '?import=1'), true);
  assert.equal(P.wantsOpen(IMPORT, '?from=analyser'), false);
  assert.equal(P.wantsOpen(IMPORT, '?new=1'), false);
});

test('opening marks the URL and keeps other parameters', () => {
  assert.equal(P.panelSearch(NEW, '', true), '?new=1');
  assert.equal(P.panelSearch(NEW, '?status=open', true), '?status=open&new=1');
  assert.equal(P.panelSearch(IMPORT, '?new=1', true), '?new=1&import=1');
});

test('closing drops only that panel\'s parameters', () => {
  assert.equal(P.panelSearch(NEW, '?new=1&from=analyser', false), ''); // no re-read of the prefill
  assert.equal(P.panelSearch(NEW, '?status=open&new=1', false), '?status=open');
  assert.equal(P.panelSearch(IMPORT, '?new=1&import=1', false), '?new=1');
});
