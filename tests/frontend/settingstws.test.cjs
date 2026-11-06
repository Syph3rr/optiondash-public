'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chipView } = require('../../web/shared/nav.js');
const { twsView } = require('../../modules/settings/web/tws.js');

const view = (state) => twsView(state, chipView);
const ON = { sidecar: 'online', ibkr: 'connected', reason: null };
const OFF = { sidecar: 'online', ibkr: 'disconnected', reason: 'press Connect IBKR' };

test('connected: only Disconnect is usable', () => {
  const v = view({ status: ON });
  assert.equal(v.tone, 'ok');
  assert.equal(v.connected, true);
  assert.match(v.message, /Connected to TWS/);
  assert.equal(v.connect.disabled, true);
  assert.equal(v.disconnect.disabled, false);
});

test('disconnected: only Connect is usable', () => {
  const v = view({ status: OFF });
  assert.equal(v.connected, false);
  assert.equal(v.message, 'press Connect IBKR');
  assert.equal(v.connect.disabled, false);
  assert.equal(v.disconnect.disabled, true);
});

test('busy: both locked and the message says what is happening', () => {
  const c = view({ status: OFF, busy: 'connect' });
  assert.equal(c.message, 'Connecting…');
  assert.equal(c.connect.disabled && c.disconnect.disabled, true);
  const d = view({ status: ON, busy: 'disconnect' });
  assert.equal(d.message, 'Disconnecting…');
  assert.equal(d.connected, false);
  assert.equal(d.connect.disabled && d.disconnect.disabled, true);
});

test('another component busy: both locked, state still shown', () => {
  for (const status of [ON, OFF]) {
    const v = view({ status, locked: true });
    assert.equal(v.connect.disabled && v.disconnect.disabled, true);
    assert.match(v.message, /another part of the app is connecting/);
  }
});

test('sidecar offline: error tone, nothing to press', () => {
  const v = view({ status: { sidecar: 'offline', ibkr: 'connected', reason: 'python missing' } });
  assert.equal(v.tone, 'err');
  assert.equal(v.connected, false);
  assert.equal(v.message, 'python missing');
  assert.equal(v.connect.disabled && v.disconnect.disabled, true);
});

test('failed connect: the failure is the message and Connect stays available', () => {
  const v = view({ status: OFF, error: 'TWS not running' });
  assert.equal(v.tone, 'err');
  assert.equal(v.message, 'TWS not running');
  assert.equal(v.connect.disabled, false);
  assert.equal(v.disconnect.disabled, true);
});

test('before the first answer or when the server is unreachable nothing is pressable', () => {
  const a = view({});
  assert.equal(a.message, 'Checking the TWS connection');
  assert.equal(a.connect.disabled && a.disconnect.disabled, true);
  const b = view({ error: 'server not reachable' });
  assert.equal(b.message, 'server not reachable');
  assert.equal(b.connect.disabled && b.disconnect.disabled, true);
});

test('never both buttons usable across every combination', () => {
  for (const status of [null, ON, OFF, { sidecar: 'offline', ibkr: 'disconnected' }])
    for (const busy of [null, 'connect', 'disconnect'])
      for (const locked of [false, true])
        for (const error of ['', 'boom']) {
          const v = view({ status, busy, locked, error });
          assert.ok(v.connect.disabled || v.disconnect.disabled);
        }
});
