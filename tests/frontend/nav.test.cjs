'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('../../web/shared/nav.js');

test('the analyser owns the root path', () => {
  assert.equal(N.activeSection('/'), 'analyser');
  assert.equal(N.activeSection(''), 'analyser');
});

test('journal pages map to their sections, trailing slash or not', () => {
  assert.equal(N.activeSection('/journal/'), 'trades');
  assert.equal(N.activeSection('/journal'), 'trades');
  assert.equal(N.activeSection('/journal/trade'), 'trades');
  assert.equal(N.activeSection('/portfolio'), 'portfolio');
  // The old IBKR page is a redirect now; it is no longer a section of its own.
  assert.equal(N.activeSection('/journal/ibkr'), null);
});

test('unknown paths highlight nothing', () => {
  assert.equal(N.activeSection('/journal/newer'), null);
  assert.equal(N.activeSection('/analyser/controls.js'), null);
});

test('every section links to a path that maps back to it', () => {
  for (const s of N.SECTIONS) assert.equal(N.activeSection(s.href), s.id, s.href);
});

test('build marks only the current section', () => {
  // Minimal DOM stand-in: just what build() touches.
  const el = (tag) => ({
    tag, children: [], attrs: {}, className: '', textContent: '', href: '',
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
  });
  const doc = { createElement: el, createTextNode: (t) => ({ text: t }) };
  const nav = N.build(doc, '/settings');
  const links = nav.children.filter((c) => c.tag === 'a' && c.className !== 'brand');
  assert.equal(links.length, N.SECTIONS.length);
  const on = links.filter((a) => a.className === 'on');
  assert.deepEqual(on.map((a) => a.textContent), ['Settings']);
  assert.equal(on[0].attrs['aria-current'], 'page');
});

// ---------------------------------------------------------------- TWS chip

test('chip before the first status answer is neutral with no button', () => {
  const v = N.chipView({});
  assert.equal(v.tone, 'off');
  assert.equal(v.button.hidden, true);
});

test('connected shows green with a Disconnect action', () => {
  const v = N.chipView({ status: { sidecar: 'online', ibkr: 'connected', reason: null } });
  assert.equal(v.tone, 'ok');
  assert.equal(v.label, 'TWS connected');
  assert.deepEqual([v.button.text, v.button.action, v.button.disabled], ['Disconnect', 'disconnect', false]);
});

test('disconnected shows grey with Connect and the server reason on hover', () => {
  const v = N.chipView({ status: { sidecar: 'online', ibkr: 'disconnected', reason: 'press Connect IBKR' } });
  assert.equal(v.tone, 'off');
  assert.equal(v.label, 'TWS off');
  assert.equal(v.title, 'press Connect IBKR');
  assert.equal(v.button.action, 'connect');
});

test('market service offline is an error with no button to press', () => {
  const v = N.chipView({ status: { sidecar: 'offline', ibkr: 'disconnected', reason: 'python missing' } });
  assert.equal(v.tone, 'err');
  assert.equal(v.title, 'python missing');
  assert.equal(v.button.hidden, true);
});

test('a failed attempt stays visible as an error but still offers Connect', () => {
  const v = N.chipView({ status: { sidecar: 'online', ibkr: 'disconnected' }, error: 'TWS refused' });
  assert.equal(v.tone, 'err');
  assert.equal(v.label, 'TWS error');
  assert.equal(v.title, 'TWS refused');
  assert.equal(v.button.action, 'connect');
});

test('status unreachable with an error shows the error, no button', () => {
  const v = N.chipView({ status: null, error: 'server not reachable' });
  assert.equal(v.tone, 'err');
  assert.equal(v.button.hidden, true);
});

test('while a request is in flight the button is disabled and says what is happening', () => {
  const c = N.chipView({ status: { sidecar: 'online', ibkr: 'disconnected' }, busy: 'connect' });
  assert.deepEqual([c.tone, c.button.text, c.button.disabled, c.button.action], ['busy', 'Connecting…', true, null]);
  const d = N.chipView({ status: { sidecar: 'online', ibkr: 'connected' }, busy: 'disconnect' });
  assert.equal(d.button.text, 'Disconnecting…');
});

test('failure text prefers the server message, then a 409 hint, then the code', () => {
  assert.equal(N.failureText(503, { error: 'market data offline: x' }), 'market data offline: x');
  assert.equal(N.failureText(409, null), 'not connected to TWS');
  assert.equal(N.failureText(500, {}), 'TWS request failed (500)');
});

test('a 200 connect reply that left TWS disconnected counts as a failure', () => {
  assert.equal(N.connectOutcome({ ibkr: 'connected' }), '');
  assert.equal(N.connectOutcome({ ibkr: 'disconnected', reason: 'TWS refused' }), 'TWS refused');
  assert.equal(N.connectOutcome({ ibkr: 'disconnected' }), 'TWS not connected');
});

test('broker routes and the change event are the shared contract', () => {
  assert.deepEqual(N.BROKER, {
    status: '/api/broker/status', connect: '/api/broker/connect', disconnect: '/api/broker/disconnect',
  });
  assert.equal(N.BROKER_EVENT, 'broker:changed');
});

test('nav.js has no timers: the chip never polls', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../web/shared/nav.js'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout/);
});

// ---------------------------------------------------------------- review fixes

test('errors show as short visible text; the full text stays in the tooltip', () => {
  const long = 'could not connect to TWS on 127.0.0.1:7496: connection refused by the remote host';
  const v = N.chipView({ status: { ibkr: 'disconnected' }, error: long });
  assert.ok(v.note.length <= 48 && v.note.endsWith('…'));
  assert.equal(v.title, long);
  assert.equal(N.chipView({ status: { ibkr: 'connected' } }).note, '');
  assert.equal(N.truncate('short', 48), 'short');
});

test('an error is kept until the connection state changes', () => {
  const off = { ibkr: 'disconnected', sidecar: 'online' };
  const on = { ibkr: 'connected', sidecar: 'online' };
  assert.equal(N.keepError(off, { ...off }, 'refused'), 'refused');
  assert.equal(N.keepError(off, on, 'refused'), '');
  assert.equal(N.keepError(null, off, 'refused'), 'refused');
  assert.equal(N.keepError(off, off, ''), '');
});

test('while another component connects, the chip button is disabled', () => {
  const v = N.chipView({ status: { ibkr: 'disconnected' }, locked: true });
  assert.equal(v.button.disabled, true);
  assert.equal(v.button.action, 'connect');
  assert.match(v.title, /another part of the app/);
  assert.equal(N.othersBusy(new Set(['nav']), 'nav'), false);
  assert.equal(N.othersBusy(new Set(['analyser']), 'nav'), true);
});

test('the chip is a labelled group with a polite live region for errors', () => {
  const made = [];
  const node = () => {
    const attrs = {};
    const n = { attrs, children: [], setAttribute: (k, v) => { attrs[k] = v; }, appendChild: (c) => n.children.push(c) };
    made.push(n);
    return n;
  };
  const ui = N.buildChip({ createElement: node });
  assert.equal(ui.chip.attrs.role, 'group');
  assert.equal(ui.chip.attrs['aria-label'], 'TWS connection');
  assert.equal(ui.note.attrs.role, 'status');
  assert.equal(ui.note.attrs['aria-live'], 'polite');
});

// A fake window: EventTarget + scripted fetch. Each fetch call is parked until the test
// resolves it, so ordering is under the test's control.
function harness() {
  const win = new EventTarget();
  win.CustomEvent = CustomEvent;
  win.calls = [];
  win.fetch = (url, init) => new Promise((resolve) => {
    win.calls.push({ url, method: (init && init.method) || 'GET', reply: (body, status = 200) =>
      resolve({ ok: status < 400, status, json: async () => body }) });
  });
  win.events = [];
  for (const name of ['broker:status', 'broker:busy', 'broker:changed']) {
    win.addEventListener(name, (e) => win.events.push([name, e.detail]));
  }
  const el = () => ({ dataset: {}, setAttribute() {}, addEventListener(type, fn) { this.on = fn; } });
  const ui = { chip: el(), label: el(), note: el(), btn: el() };
  const ctl = N.wireBroker(win, ui);
  return { win, ui, ctl };
}
const tick = () => new Promise((r) => setImmediate(r));
const OFF = { sidecar: 'online', ibkr: 'disconnected', reason: 'not connected' };
const ON = { sidecar: 'online', ibkr: 'connected', reason: null };

test('refreshes coalesce: one status GET in flight, one follow-up at most', async () => {
  const { win, ctl } = harness();
  ctl.refresh(); ctl.refresh(); ctl.refresh();
  assert.equal(win.calls.length, 1, 'load read only');
  win.calls[0].reply(OFF);
  await tick(); await tick();
  assert.equal(win.calls.length, 2, 'a single follow-up for the three calls');
  win.calls[1].reply(OFF);
  await tick(); await tick();
  assert.equal(win.calls.length, 2);
});

test('every refresh shares its status with pages via broker:status', async () => {
  const { win } = harness();
  win.calls[0].reply(ON);
  await tick(); await tick();
  const shared = win.events.filter(([n]) => n === 'broker:status');
  assert.deepEqual(shared.at(-1)[1], { source: 'nav', status: ON });
});

test('a status answer made stale by a press never overwrites the result', async () => {
  const { win, ui, ctl } = harness();
  win.calls[0].reply(ON);
  await tick(); await tick();
  ctl.refresh();                       // read #2 in flight (will say "connected")
  const press = ctl.act('disconnect'); // press while it is in flight
  await tick();
  const disc = win.calls.find((c) => c.url.endsWith('/disconnect'));
  disc.reply(OFF);
  await tick();
  win.calls[1].reply(ON);              // the stale "connected" answer lands late
  await tick(); await tick();
  win.calls.at(-1).reply(OFF);         // the follow-up read after the press
  await press;
  assert.equal(ctl.state.status.ibkr, 'disconnected');
  assert.equal(ui.label.textContent, 'TWS off');
});

test('a failed press stays visible after the follow-up read', async () => {
  const { win, ui, ctl } = harness();
  win.calls[0].reply(OFF);
  await tick(); await tick();
  const press = ctl.act('connect');
  await tick();
  win.calls.find((c) => c.url.endsWith('/connect')).reply({ error: 'TWS refused' }, 502);
  await tick(); await tick();
  win.calls.at(-1).reply(OFF);
  await press;
  assert.equal(ui.note.textContent, 'TWS refused');
  // a later focus read with the same state keeps it
  win.dispatchEvent(new CustomEvent('focus'));
  await tick();
  win.calls.at(-1).reply(OFF);
  await tick(); await tick();
  assert.equal(ui.note.textContent, 'TWS refused');
});

test('busy events from others lock the chip; a press then does nothing', async () => {
  const { win, ui, ctl } = harness();
  win.calls[0].reply(OFF);
  await tick(); await tick();
  win.dispatchEvent(new CustomEvent('broker:busy', { detail: { source: 'analyser', busy: true } }));
  assert.equal(ui.btn.disabled, true);
  const before = win.calls.length;
  await ctl.act('connect');
  assert.equal(win.calls.length, before, 'no request while another component connects');
  win.dispatchEvent(new CustomEvent('broker:busy', { detail: { source: 'analyser', busy: false } }));
  assert.equal(ui.btn.disabled, false);
});

test('a press announces busy, then the change, tagged as the nav', async () => {
  const { win, ctl } = harness();
  win.calls[0].reply(OFF);
  await tick(); await tick();
  const press = ctl.act('connect');
  await tick();
  win.calls.find((c) => c.url.endsWith('/connect')).reply(ON);
  await tick(); await tick();
  win.calls.at(-1).reply(ON);
  await press;
  const names = win.events.filter(([n]) => n !== 'broker:status').map(([n, d]) => [n, d]);
  assert.deepEqual(names, [
    ['broker:busy', { source: 'nav', busy: true }],
    ['broker:busy', { source: 'nav', busy: false }],
    ['broker:changed', { source: 'nav' }],
  ]);
});

test('soon modules (if any) show in the sidebar but are not links or sections', () => {
  const soon = N.MODULES.filter((m) => m.soon);
  for (const m of soon) {
    for (const p of m.pages) assert.ok(!N.SECTIONS.some((s) => s.id === p.id), p.id);
  }
});

test('registry ids are unique', () => {
  const ids = N.MODULES.flatMap((m) => m.pages.map((p) => p.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('moved pages are no longer in the sidebar', () => {
  // New trade lives on the Trades page; the Dashboard's charts are on Home.
  const labels = N.SECTIONS.map((x) => x.label);
  assert.ok(!labels.includes('New trade') && !labels.includes('Dashboard'), labels.join(', '));
  assert.equal(N.activeSection('/journal/new'), null);
  assert.equal(N.activeSection('/journal/dashboard'), null);
});

test('Portfolio sits in Overview, after Home', () => {
  const overview = N.MODULES.filter((m) => m.group === 'Overview').map((m) => m.id);
  assert.deepEqual(overview, ['home', 'portfolio']);
});

test('the sidebar groups: Overview, Analysis, Journal, then Settings pinned last', () => {
  const groups = [...new Set(N.MODULES.map((m) => m.group))];
  assert.deepEqual(groups, ['Overview', 'Analysis', 'Journal', 'Settings']);
  const analysis = N.MODULES.filter((m) => m.group === 'Analysis').flatMap((m) => m.pages.map((p) => p.label));
  assert.deepEqual(analysis, ['Options Analyser', 'Chain & screener']);
  assert.ok(N.MODULES.find((m) => m.group === 'Settings').pinned);
  assert.equal(N.activeSection('/settings'), 'settings');
  const pages = N.MODULES.find((m) => m.group === 'Settings').pages.map((p) => p.label);
  assert.deepEqual(pages, ['Settings']);
  assert.ok(!N.SECTIONS.some((s) => /ibkr/i.test(s.id) || /ibkr/i.test(s.href)));
});

test('build puts one spacer before the pinned Settings group', () => {
  const el = (tag) => ({ tag, children: [], attrs: {}, className: '', textContent: '', href: '',
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; } });
  const nav = N.build({ createElement: el, createTextNode: (t) => ({ text: t }) }, '/');
  const kids = nav.children;
  const spacers = kids.filter((c) => c.className === 'od-spacer');
  assert.equal(spacers.length, 1);
  const next = kids[kids.indexOf(spacers[0]) + 1];
  assert.equal(next.className, 'od-group');
  assert.equal(next.textContent, 'Settings');
});
