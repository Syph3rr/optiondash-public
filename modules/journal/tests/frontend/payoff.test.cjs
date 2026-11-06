const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../static/js/payoff.js");

const leg = (kind, strike, qty, price, multiplier = 100) => ({ kind, strike, qty, price, multiplier });

// Same cases and numbers as tests/test_pricing.py, so client preview and server agree.
test("short put spread", () => {
  const s = P.summarise([leg("put", 540, -1, 3.0), leg("put", 535, 1, 1.8)], 550);
  assert.equal(s.netPremium, 120);
  assert.equal(s.maxProfit, 120);
  assert.equal(s.maxLoss, 380);
  assert.deepEqual(s.breakevens, [538.8]);
});

test("iron condor", () => {
  const legs = [leg("put", 90, 1, 0.5), leg("put", 95, -1, 1.5), leg("call", 105, -1, 1.5), leg("call", 110, 1, 0.5)];
  const s = P.summarise(legs, 100);
  assert.equal(s.maxProfit, 200);
  assert.equal(s.maxLoss, 300);
  assert.deepEqual(s.breakevens, [93, 107]);
});

test("unbounded sides", () => {
  assert.equal(P.summarise([leg("call", 100, -1, 2)], 100).maxLoss, null);
  const long = P.summarise([leg("call", 100, 2, 2)], 100);
  assert.equal(long.maxProfit, null);
  assert.equal(long.maxLoss, 400);
});

test("covered call uses multiplier 1 for stock by default", () => {
  const legs = [{ kind: "stock", qty: 100, price: 100 }, leg("call", 105, -1, 2)];
  const s = P.summarise(legs, 100);
  assert.equal(s.maxProfit, 700);
  assert.deepEqual(s.breakevens, [98]);
});

test("curve covers strikes and settles at intrinsic", () => {
  const c = P.curve([leg("call", 100, 1, 2)], 100);
  assert.ok(c.prices.includes(100));
  assert.equal(c.pnl[c.prices.indexOf(100)], -200);
  assert.equal(P.pnlAt([leg("call", 100, 1, 2)], 110), 800);
});

test("empty legs", () => {
  assert.deepEqual(P.summarise([], 100), { maxProfit: 0, maxLoss: 0, breakevens: [], netPremium: 0 });
});

test("extremes at a price of 0 are exact (grid starts at 0)", () => {
  assert.equal(P.summarise([leg("put", 100, 1, 3)], 100).maxProfit, 9700);
  const covered = [{ kind: "stock", qty: 100, price: 100 }, leg("call", 105, -1, 2)];
  assert.equal(P.summarise(covered, 100).maxLoss, 9800);
});

test("a zero-cost structure's flat $0 run gives only its ends as breakevens", () => {
  // Put broken-wing butterfly 110 / 105x2 / 95 for zero cost: P&L is exactly 0 above 110.
  const legs = [leg("put", 110, 1, 4.1), leg("put", 105, -2, 2.6), leg("put", 95, 1, 1.1)];
  const s = P.summarise(legs, 105);
  assert.deepEqual(s.breakevens, [100, 110]);
  assert.equal(s.maxProfit, 500);
  assert.equal(s.maxLoss, 500);
});

test("a $0 run from the bottom of the grid only reports where it ends", () => {
  assert.deepEqual(P.summarise([leg("call", 100, 1, 0)], 100).breakevens, [100]);
});
