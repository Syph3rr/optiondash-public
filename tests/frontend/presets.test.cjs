'use strict';
// Run with: node --test "tests/frontend/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../modules/analyser/web/presets.js');
const S = require('../../modules/journal/static/js/strategies.js');

const SPOT = 100;
// Same shape as the page's leg builder, with whole-number strikes and DTE in days.
const makeLeg = (kind, long, offset, opts = {}) => ({
  kind, long, qty: opts.qty ?? 1, dte: opts.dte ?? 30,
  strike: kind === 'stock' ? 0 : Math.round(SPOT * (1 + offset)),
});
// What the journal sees: signed quantity, one expiry per DTE.
const asJournalLegs = (legs) => legs.map((l) => ({
  kind: l.kind, strike: l.strike, expiry: `d${l.dte}`, qty: l.long ? l.qty : -l.qty,
}));

// Same legs, so the journal cannot tell them apart; the preset is still worth having by name.
const SAME_SHAPE = { cash_secured_put: 'short_put' };

test('every strategy the journal can log has an analyser preset', () => {
  const have = new Set(P.ALL.map((p) => p.strategy));
  const missing = Object.keys(S.TEMPLATES).filter((id) => id !== 'custom' && !have.has(id));
  assert.deepEqual(missing, []);
});

test('preset names are unique and every preset has legs', () => {
  const names = P.ALL.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const p of P.ALL) assert.ok(p.legs.length > 0, p.name);
});

test('each preset builds legs that the journal recognises as that strategy', () => {
  for (const p of P.ALL) {
    const legs = P.build(p.name, makeLeg);
    assert.equal(legs.length, p.legs.length, p.name);
    const guessed = S.guessStrategy(asJournalLegs(legs));
    assert.equal(guessed, SAME_SHAPE[p.strategy] || p.strategy, p.name);
  }
});

test('a preset follows the journal template: same sides, kinds and ratios', () => {
  for (const p of P.ALL) {
    const tpl = S.TEMPLATES[p.strategy];
    const legs = P.build(p.name, makeLeg);
    // Calendars and diagonals work the same with puts or calls, so only their sides and ratios must match.
    const anyKind = p.strategy === 'calendar' || p.strategy === 'diagonal';
    const kind = (k) => (anyKind ? '*' : k);
    const want = tpl.map((t) => `${t.side}:${kind(t.kind)}:${t.ratio}`).sort();
    const got = legs.map((l) => `${l.long ? 'buy' : 'sell'}:${kind(l.kind)}:${l.qty}`).sort();
    assert.deepEqual(got, want, p.name);
  }
});

test('build returns null for an unknown name and never changes the presets', () => {
  assert.equal(P.build('Nope', makeLeg), null);
  const before = JSON.stringify(P.ALL);
  P.build('Iron Condor', makeLeg);
  assert.equal(JSON.stringify(P.ALL), before);
  assert.ok(Object.isFrozen(P.ALL));
});

test('groups cover every preset exactly once', () => {
  const grouped = P.GROUPS.flatMap((g) => g.presets.map((p) => p.name));
  assert.deepEqual([...grouped].sort(), P.ALL.map((p) => p.name).sort());
  assert.equal(new Set(grouped).size, grouped.length);
});

// ---------------------------------------------------------------- re-centre on a loaded spot

const round5 = (k) => Math.round(k / 5) * 5;
const what = (strike, o = {}) => ({ kind: 'put', long: true, qty: 1, strike, dte: 30, premium: null, fill: null, live: null, ...o });

test('recentre scales an untouched what-if shape from the placeholder spot to the real one', () => {
  // The default condor drawn for 5800, then SPX loads at 7688.
  const legs = Object.freeze([what(5395), what(5595, { long: false }), what(6005, { kind: 'call', long: false }), what(6205, { kind: 'call' })]);
  const out = P.recentre(legs, 5800, 7688, round5);
  assert.deepEqual(out.map((l) => l.strike), [7150, 7415, 7960, 8225]);
  assert.deepEqual(out.map((l) => [l.kind, l.long]), legs.map((l) => [l.kind, l.long])); // same shape
  assert.equal(legs[0].strike, 5395); // input unchanged
  assert.equal(new Set(out.map((l) => l.strike)).size, 4); // no two legs collapse onto one strike
});

test('recentre leaves legs alone when the user has made them real', () => {
  const base = [what(5395), what(6205, { kind: 'call' })];
  assert.equal(P.recentre([what(5395, { premium: 12 }), base[1]], 5800, 7688, round5), null); // typed premium
  assert.equal(P.recentre([what(5395, { fill: 11.5 }), base[1]], 5800, 7688, round5), null);  // my fill
  assert.equal(P.recentre([what(5395, { live: { symbol: 'SPX' } }), base[1]], 5800, 7688, round5), null); // linked
});

test('recentre leaves strikes typed at real levels, small spot moves and odd input alone', () => {
  assert.equal(P.recentre([what(7600), what(7800, { kind: 'call' })], 5800, 7688, round5), null); // already near the real spot
  assert.equal(P.recentre([what(5395), what(6205, { kind: 'call' })], 5800, 5850, round5), null); // under 2% move
  assert.equal(P.recentre([what(100)], null, 7688, round5), null);
  assert.equal(P.recentre([], 5800, 7688, round5), null);
  assert.equal(P.recentre(null, 5800, 7688, round5), null);
});

test('recentre keeps stock legs as they are and needs at least one option leg', () => {
  const stock = { kind: 'stock', long: true, qty: 100, strike: 0, dte: 0, premium: null, fill: null, live: null };
  assert.equal(P.recentre([stock], 300, 330, round5), null);
  const out = P.recentre([stock, what(310, { kind: 'call', long: false })], 300, 330, (k) => Math.round(k));
  assert.deepEqual([out[0], out[1].strike], [stock, 341]);
});

test('recentre backs off when rounding would fold two legs onto one strike', () => {
  // A tight SPX butterfly drawn at 7688, then XSP loads at a tenth of that with $1 strikes.
  const fly = [what(7600, { kind: 'call' }), what(7605, { kind: 'call', long: false, qty: 2 }), what(7610, { kind: 'call' })];
  assert.equal(P.recentre(fly, 7688, 768.8, (k) => Math.round(k)), null);
  // Same shape, wide enough to survive the rounding: re-centred.
  const wide = [what(7600, { kind: 'call' }), what(7650, { kind: 'call', long: false, qty: 2 }), what(7700, { kind: 'call' })];
  assert.deepEqual(P.recentre(wide, 7688, 768.8, (k) => Math.round(k)).map((l) => l.strike), [760, 765, 770]);
});

test('recentre treats a typed stock entry price as the user\'s, like an option premium', () => {
  const stock = { kind: 'stock', long: true, qty: 100, strike: 0, dte: 0, premium: 300, fill: null, live: null };
  assert.equal(P.recentre([stock, what(310, { kind: 'call', long: false })], 300, 330, (k) => Math.round(k)), null);
});
