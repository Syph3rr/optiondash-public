const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../static/js/strategies.js");
const F = require("../../static/js/format.js");

// Every strategy id the backend accepts (app/models.py STRATEGIES).
const BACKEND = [
  "long_call", "long_put", "short_call", "short_put", "covered_call", "cash_secured_put",
  "bull_call_spread", "bear_put_spread", "bull_put_spread", "bear_call_spread",
  "iron_condor", "iron_butterfly", "long_butterfly", "broken_wing_butterfly",
  "long_straddle", "short_straddle", "long_strangle", "short_strangle",
  "calendar", "double_calendar", "diagonal", "ratio_spread", "jade_lizard", "stock", "custom",
];

test("every backend strategy has a template and a label", () => {
  for (const id of BACKEND) {
    assert.ok(S.TEMPLATES[id], `template for ${id}`);
    assert.ok(F.STRATEGY_LABELS[id], `label for ${id}`);
  }
  assert.deepEqual(Object.keys(S.TEMPLATES).sort(), [...BACKEND].sort());
});

test("templates produce valid legs", () => {
  for (const id of BACKEND) {
    const legs = S.template(id);
    assert.ok(legs.length >= 1, id);
    for (const l of legs) {
      assert.ok(["buy", "sell"].includes(l.side), `${id} side`);
      assert.ok(["call", "put", "stock"].includes(l.kind), `${id} kind`);
      assert.ok(Number.isInteger(l.ratio) && l.ratio > 0, `${id} ratio`);
      assert.ok(["front", "back"].includes(l.group), `${id} group`);
    }
    const twoExp = legs.some((l) => l.group === "back");
    assert.equal(twoExp, S.usesTwoExpiries(id), `${id} expiry groups`);
  }
});

test("template returns copies", () => {
  const a = S.template("iron_condor");
  a[0].side = "sell";
  assert.equal(S.template("iron_condor")[0].side, "buy");
});

const E1 = "2026-12-18";
const E2 = "2027-01-15";
const leg = (kind, strike, qty, expiry = E1) => ({ kind, strike, qty, expiry });

test("guessStrategy: singles and verticals", () => {
  assert.equal(S.guessStrategy([leg("call", 100, 1)]), "long_call");
  assert.equal(S.guessStrategy([leg("put", 100, -2)]), "short_put");
  assert.equal(S.guessStrategy([leg("put", 540, -1), leg("put", 535, 1)]), "bull_put_spread");
  assert.equal(S.guessStrategy([leg("put", 540, 1), leg("put", 535, -1)]), "bear_put_spread");
  assert.equal(S.guessStrategy([leg("call", 100, 1), leg("call", 105, -1)]), "bull_call_spread");
  assert.equal(S.guessStrategy([leg("call", 100, -1), leg("call", 105, 1)]), "bear_call_spread");
  assert.equal(S.guessStrategy([leg("call", 100, 1), leg("call", 105, -2)]), "ratio_spread");
});

test("guessStrategy: straddles, strangles, time spreads", () => {
  assert.equal(S.guessStrategy([leg("put", 100, -1), leg("call", 100, -1)]), "short_straddle");
  assert.equal(S.guessStrategy([leg("put", 95, 1), leg("call", 105, 1)]), "long_strangle");
  assert.equal(S.guessStrategy([leg("call", 100, -1, E1), leg("call", 100, 1, E2)]), "calendar");
  assert.equal(S.guessStrategy([leg("call", 105, -1, E1), leg("call", 100, 1, E2)]), "diagonal");
});

test("guessStrategy: multi-leg structures", () => {
  const condor = [leg("put", 90, 1), leg("put", 95, -1), leg("call", 105, -1), leg("call", 110, 1)];
  assert.equal(S.guessStrategy(condor), "iron_condor");
  const fly = [leg("put", 90, 1), leg("put", 100, -1), leg("call", 100, -1), leg("call", 110, 1)];
  assert.equal(S.guessStrategy(fly), "iron_butterfly");
  assert.equal(S.guessStrategy([leg("call", 95, 1), leg("call", 100, -2), leg("call", 105, 1)]), "long_butterfly");
  assert.equal(S.guessStrategy([leg("put", 105, 1), leg("put", 100, -2), leg("put", 90, 1)]), "broken_wing_butterfly");
  assert.equal(S.guessStrategy([leg("put", 95, -1), leg("call", 105, -1), leg("call", 110, 1)]), "jade_lizard");
  const dcal = [leg("put", 95, -1, E1), leg("put", 95, 1, E2), leg("call", 105, -1, E1), leg("call", 105, 1, E2)];
  assert.equal(S.guessStrategy(dcal), "double_calendar");
});

test("guessStrategy: stock and fallbacks", () => {
  assert.equal(S.guessStrategy([{ kind: "stock", qty: 100 }]), "stock");
  assert.equal(S.guessStrategy([{ kind: "stock", qty: 100 }, leg("call", 105, -1)]), "covered_call");
  assert.equal(S.guessStrategy([]), "custom");
  assert.equal(S.guessStrategy([leg("call", 100, 1), leg("put", 90, -1)]), "custom");
});

test("partial fills of one contract are merged before guessing", () => {
  const exp = "2026-12-18";
  assert.equal(S.guessStrategy([
    { kind: "put", strike: 540, expiry: exp, qty: -1 },
    { kind: "put", strike: 540, expiry: exp, qty: -1 },
  ]), "short_put");
  const half = (kind, strike, qty) => [{ kind, strike, expiry: exp, qty: qty / 2 }, { kind, strike, expiry: exp, qty: qty / 2 }];
  assert.equal(S.guessStrategy([
    ...half("put", 90, 2), ...half("put", 95, -2), ...half("call", 105, -2), ...half("call", 110, 2),
  ]), "iron_condor");
});

test("mergeLegs sums qty and drops legs that net to zero", () => {
  const exp = "2026-12-18";
  const merged = S.mergeLegs([
    { kind: "call", strike: 100, expiry: exp, qty: 1 },
    { kind: "call", strike: 100, expiry: exp, qty: -1 },
    { kind: "put", strike: 95, expiry: exp, qty: -1 },
    { kind: "put", strike: 95, expiry: exp, qty: -2 },
  ]);
  assert.deepEqual(merged, [{ kind: "put", strike: 95, expiry: exp, qty: -3 }]);
});
