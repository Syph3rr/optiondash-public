const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../static/js/laterfills.js");

const call = { side: "buy", qty: 10, kind: "call", strike: 100, expiry: "2026-12-18", price: 2 };
const legs = L.openingLegs([call]);
const KEY = legs[0].key;
const row = (qty, extra = {}) => ({ key: KEY, include: true, side: "sell", qty, price: 3, commission: null, auto: false, ...extra });
const block = (date, qty, extra = {}) => ({ event: "close", date, fills: [row(qty, extra)] });

test("openingLegs signs and merges the same contract, null while incomplete", () => {
  const merged = L.openingLegs([call, { ...call, qty: 5 }, { side: "sell", qty: 3, kind: "stock", strike: null, expiry: null, price: 50 }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].qty, 15);
  assert.deepEqual([merged[1].key, merged[1].qty], ["stock", -3]);
  assert.equal(L.openingLegs([{ ...call, strike: null }]), null);
  assert.equal(L.openingLegs([{ ...call, expiry: "" }]), null);
  assert.equal(L.openingLegs([]), null);
});

test("a new block closes whatever is still open after earlier blocks", () => {
  const rows = L.newBlockRows(legs, [block("2026-10-08", 4)]);
  assert.deepEqual(rows.map((r) => [r.side, r.qty, r.include]), [["sell", 6, true]]);
  const none = L.newBlockRows(legs, [block("2026-10-08", 10)]);
  assert.deepEqual(none.map((r) => [r.qty, r.include]), [[0, false]]);
});

test("a short leg is prefilled to buy back", () => {
  const short = L.openingLegs([{ ...call, side: "sell", qty: 2 }]);
  assert.deepEqual(L.newBlockRows(short, []).map((r) => [r.side, r.qty]), [["buy", 2]]);
});

test("blocks are applied oldest date first, ties in the given order", () => {
  const blocks = [block("2026-10-15", 6), block("2026-10-08", 1), block("2026-10-08", 3), block("", 1)];
  assert.deepEqual(L.chronological(blocks), [1, 2, 0, 3]);
  const { before, after } = L.walk(legs, blocks);
  assert.deepEqual([before[1].get(KEY), before[2].get(KEY), before[0].get(KEY)], [10, 9, 6]);
  assert.equal(after.get(KEY), -1);
});

test("ladder shows the open qty after each block that touches the leg", () => {
  const blocks = [block("2026-10-15", 6), block("2026-10-08", 4), block("2026-10-20", 1, { include: false })];
  assert.deepEqual(L.ladder(legs, blocks), [{ key: KEY, steps: [10, 6, 0] }]);
});

test("validate passes two partial closes", () => {
  assert.deepEqual(L.validate(legs, [block("2026-10-08", 4), block("2026-10-15", 6)], "2026-10-01").errors, []);
});

test("validate refuses closing more than is open across blocks", () => {
  const { errors } = L.validate(legs, [block("2026-10-08", 4), block("2026-10-15", 7)], "2026-10-01");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Close #2 \(2026-10-15\): .*only 6 open/);
});

test("validate checks date, price, qty and that something is ticked", () => {
  const opened = "2026-10-01";
  assert.match(L.validate(legs, [block("", 4)], opened).errors[0], /pick the date/);
  assert.match(L.validate(legs, [block("2026-09-30", 4)], opened).errors[0], /before the trade was opened/);
  assert.match(L.validate(legs, [block("2026-10-08", 4, { price: null })], opened).errors[0], /fill price/);
  assert.match(L.validate(legs, [block("2026-10-08", 0)], opened).errors[0], /above 0/);
  assert.match(L.validate(legs, [block("2026-10-08", 4, { commission: -1 })], opened).errors[0], /commission/);
  assert.match(L.validate(legs, [block("2026-10-08", 4, { include: false })], opened).errors[0], /tick at least one/);
});

test("a close may not add to the position, but an adjust may", () => {
  const add = { ...block("2026-10-08", 2, { side: "buy" }) };
  assert.match(L.validate(legs, [add], "2026-10-01").errors[0], /must sell/);
  assert.deepEqual(L.validate(legs, [{ ...add, event: "adjust" }], "2026-10-01").errors, []);
});

test("buildEvents describes legs in full and skips unticked rows", () => {
  const stock = L.openingLegs([call, { side: "buy", qty: 100, kind: "stock", strike: null, expiry: null, price: 50 }]);
  const blocks = [
    { event: "close", date: "2026-10-08", fills: [row(4, { commission: 0.65 }), { ...row(100), key: "stock", include: false }] },
    { event: "close", date: "2026-10-09", fills: [{ ...row(100), key: "stock", include: false }] },
    { event: "expire", date: "2026-12-18", fills: [row(6, { price: 0 }), { ...row(100), key: "stock", price: 49 }] },
  ];
  assert.deepEqual(L.buildEvents(stock, blocks), [
    { event: "close", executed_at: "2026-10-08",
      fills: [{ leg: { kind: "call", strike: 100, expiry: "2026-12-18" }, qty: -4, price: 3, commission: 0.65 }] },
    { event: "expire", executed_at: "2026-12-18", fills: [
      { leg: { kind: "call", strike: 100, expiry: "2026-12-18" }, qty: -6, price: 0, commission: 0 },
      { leg: { kind: "stock" }, qty: -100, price: 49, commission: 0 }] },
  ]);
});

test("realised uses average cost, like the server's ledger", () => {
  const blocks = [block("2026-10-15", 6, { price: 2.5 }), block("2026-10-08", 4, { price: 3 })];
  assert.equal(L.realised(legs, blocks), 700);
  assert.equal(L.realised(legs, [block("2026-10-08", 4, { price: null })]), null);
  // add 10 more at 4.00 (avg 3.00), then sell 20 at 3.50: +1000
  const scaled = [{ event: "adjust", date: "2026-10-05", fills: [row(10, { side: "buy", price: 4 })] }, block("2026-10-09", 20, { price: 3.5 })];
  assert.equal(L.realised(legs, scaled), 1000);
});

test("refit keeps typed values by contract and re-prefills untouched quantities", () => {
  const blocks = [block("2026-10-08", 4, { price: 3.2 }), block("2026-10-15", 6, { auto: true, price: 2.5 })];
  const bigger = L.openingLegs([{ ...call, qty: 20 }]);
  const out = L.refit(bigger, blocks, legs);
  assert.deepEqual(out.map((b) => [b.date, b.fills[0].qty, b.fills[0].price]), [["2026-10-08", 4, 3.2], ["2026-10-15", 16, 2.5]]);
});

test("refit carries values by position when a strike is edited, and adds rows for new legs", () => {
  const blocks = [block("2026-10-08", 4, { price: 3.2 })];
  const moved = L.openingLegs([{ ...call, strike: 105 }]);
  const out = L.refit(moved, blocks, legs);
  assert.deepEqual([out[0].fills[0].key, out[0].fills[0].qty, out[0].fills[0].price], [moved[0].key, 4, 3.2]);
  const two = L.openingLegs([call, { ...call, strike: 110, side: "sell" }]);
  const grown = L.refit(two, blocks, legs);
  assert.equal(grown[0].fills.length, 2);
  assert.deepEqual([grown[0].fills[1].side, grown[0].fills[1].qty, grown[0].fills[1].include], ["buy", 10, true]);
});

test("openingLegs averages the price of a contract on two rows, like the ledger", () => {
  const two = L.openingLegs([{ ...call, qty: 1, price: 2 }, { ...call, qty: 1, price: 4 }]);
  assert.equal(two.length, 1);
  assert.equal(two[0].qty, 2);
  assert.equal(two[0].price, 3);
  const close = [{ event: "close", date: "2026-10-08", fills: [{ key: two[0].key, include: true, side: "sell", qty: 2, price: 3, commission: null, auto: false }] }];
  assert.equal(L.realised(two, close), 0);
  // Crossing zero starts a new average at the price that flipped it.
  const flip = L.openingLegs([{ ...call, qty: 1, price: 2 }, { ...call, side: "sell", qty: 3, price: 5 }]);
  assert.deepEqual([flip[0].qty, flip[0].price], [-2, 5]);
  // Reducing keeps the average.
  const part = L.openingLegs([{ ...call, qty: 3, price: 2 }, { ...call, side: "sell", qty: 1, price: 5 }]);
  assert.deepEqual([part[0].qty, part[0].price], [2, 2]);
  // A missing price leaves the merged price unknown.
  assert.equal(L.openingLegs([{ ...call, qty: 1, price: 2 }, { ...call, qty: 1, price: null }])[0].price, null);
});
