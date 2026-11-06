const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../static/js/prefill.js");
const S = require("../../static/js/strategies.js");

const spread = {
  underlying: "spy", underlying_entry: 550, iv_entry: 18.5,
  legs: [
    { kind: "put", side: "sell", qty: 1, strike: 540, expiry: "2026-12-18", price: 3.0 },
    { kind: "put", side: "buy", qty: 1, strike: 535, expiry: "2026-12-18", price: 1.8 },
  ],
};

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    removeItem: (k) => { delete data[k]; },
    data,
  };
}

test("valid prefill is cleaned: symbol upper-cased, missing fields null", () => {
  const p = P.parsePrefill(JSON.stringify(spread));
  assert.equal(p.underlying, "SPY");
  assert.equal(p.strategy, null);
  assert.equal(p.opened_at, null);
  assert.equal(p.underlying_entry, 550);
  assert.equal(p.iv_entry, 18.5);
  assert.deepEqual(p.legs[0], { kind: "put", side: "sell", qty: 1, strike: 540, expiry: "2026-12-18", price: 3.0 });
});

test("stock legs drop strike and expiry; price may be missing", () => {
  const p = P.parsePrefill({ underlying: "AAPL", legs: [{ kind: "stock", side: "buy", qty: 100, strike: 5, expiry: "2026-01-01" }] });
  assert.deepEqual(p.legs[0], { kind: "stock", side: "buy", qty: 100, strike: null, expiry: null, price: null });
});

test("invalid prefills give readable errors", () => {
  const leg = spread.legs[0];
  const cases = [
    ["{not json", /could not be read/],
    [{ ...spread, underlying: "1BAD" }, /underlying/],
    [{ ...spread, legs: [] }, /no legs/],
    [{ ...spread, legs: [{ ...leg, kind: "future" }] }, /kind/],
    [{ ...spread, legs: [{ ...leg, side: "long" }] }, /side/],
    [{ ...spread, legs: [{ ...leg, qty: 0 }] }, /quantity/],
    [{ ...spread, legs: [{ ...leg, strike: -1 }] }, /strike/],
    [{ ...spread, legs: [{ ...leg, expiry: "18/12/2026" }] }, /expiry/],
    [{ ...spread, legs: [{ ...leg, price: -0.5 }] }, /price/],
    [{ ...spread, underlying_entry: -5 }, /Underlying price/],
    [{ ...spread, legs: Array(21).fill(leg) }, /at most 20/],
  ];
  for (const [input, re] of cases) assert.throws(() => P.parsePrefill(input), re, JSON.stringify(input).slice(0, 60));
});

test("strategy: the analyser's id when known, otherwise guessed from the legs", () => {
  const known = ["bull_put_spread", "custom"];
  assert.equal(P.chooseStrategy({ ...P.parsePrefill(spread), strategy: "bull_put_spread" }, known, S.guessStrategy), "bull_put_spread");
  assert.equal(P.chooseStrategy({ ...P.parsePrefill(spread), strategy: "made_up" }, known, S.guessStrategy), "bull_put_spread");
  assert.equal(P.chooseStrategy(P.parsePrefill(spread), known, S.guessStrategy), "bull_put_spread");
});

test("take reads once and removes the stored strategy", () => {
  const store = memoryStorage({ [P.KEY]: JSON.stringify(spread) });
  assert.equal(P.take(store).underlying, "SPY");
  assert.equal(P.KEY in store.data, false);
  assert.equal(P.take(store), null);
});

test("take removes a broken prefill and reports it", () => {
  const store = memoryStorage({ [P.KEY]: "{oops" });
  assert.throws(() => P.take(store), /could not be read/);
  assert.equal(P.KEY in store.data, false);
});

test("take treats blocked storage as empty", () => {
  const blocked = { getItem() { throw new Error("SecurityError"); }, removeItem() {} };
  assert.equal(P.take(blocked), null);
});

test("a prefill carries the account it came from (Portfolio's Log as trade), else none", () => {
  assert.equal(P.parsePrefill({ ...spread, account_id: 3 }).account_id, 3);
  assert.equal(P.parsePrefill(spread).account_id, null);
  for (const bad of [0, -1, 2.5, "3", null, "x"]) {
    assert.equal(P.parsePrefill({ ...spread, account_id: bad }).account_id, null, String(bad));
  }
});
