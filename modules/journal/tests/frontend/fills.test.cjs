const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../../static/js/fills.js");

const shortPut = { id: 1, kind: "put", strike: 540, expiry: "2026-12-18", net_qty: -1 };
const longPut = { id: 2, kind: "put", strike: 535, expiry: "2026-12-18", net_qty: 1 };
const legs = [shortPut, longPut];

test("close within the open size is fine", () => {
  const r = F.checkFills("close", legs, [{ leg_id: 1, qty: 1 }, { leg_id: 2, qty: -1 }]);
  assert.deepEqual(r, { errors: [], flips: [] });
});

test("closing more than is open is an error, not a flip", () => {
  const r = F.checkFills("close", legs, [{ leg_id: 1, qty: 3 }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /only 1 open/);
});

test("close on the same side as the position is an error", () => {
  const r = F.checkFills("expire", legs, [{ leg_id: 1, qty: -1 }]);
  assert.match(r.errors[0], /must buy/);
});

test("partial fills of one leg are summed before checking", () => {
  const ok = F.checkFills("close", [{ ...shortPut, net_qty: -2 }], [{ leg_id: 1, qty: 1 }, { leg_id: 1, qty: 1 }]);
  assert.deepEqual(ok.errors, []);
  const bad = F.checkFills("close", [{ ...shortPut, net_qty: -2 }], [{ leg_id: 1, qty: 2 }, { leg_id: 1, qty: 1 }]);
  assert.equal(bad.errors.length, 1);
});

test("close events cannot open new legs", () => {
  const r = F.checkFills("close", legs, [{ leg: { kind: "put" }, qty: -1 }]);
  assert.match(r.errors[0], /cannot open new legs/);
});

test("adjust may flip, but the flip is reported", () => {
  const r = F.checkFills("adjust", legs, [{ leg_id: 1, qty: 3 }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.flips.length, 1);
  assert.deepEqual(F.checkFills("roll", legs, [{ leg_id: 1, qty: 1 }]).flips, []);
});

test("unknown leg is an error", () => {
  assert.equal(F.checkFills("adjust", legs, [{ leg_id: 99, qty: 1 }]).errors.length, 1);
});

test("expiry plan: strictly before today, grouped per expiry, today listed apart", () => {
  const plan = F.expiryPlan([
    { id: 1, kind: "call", expiry: "2026-10-31", net_qty: -1 },
    { id: 2, kind: "call", expiry: "2026-11-07", net_qty: 1 },
    { id: 3, kind: "put", expiry: "2026-10-31", net_qty: 1 },
    { id: 4, kind: "put", expiry: "2026-11-09", net_qty: -1 },
    { id: 5, kind: "put", expiry: "2026-10-01", net_qty: 0 },
    { id: 6, kind: "stock", expiry: null, net_qty: 100 },
  ], "2026-11-09");
  assert.deepEqual(plan.groups.map((g) => [g.expiry, g.legs.map((l) => l.id)]), [["2026-10-31", [1, 3]], ["2026-11-07", [2]]]);
  assert.deepEqual(plan.today.map((l) => l.id), [4]);
});

test("suggestEvent: closing fills on matching contracts -> close", () => {
  const trade = { legs };
  const fills = [
    { kind: "put", strike: 540, expiry: "2026-12-18", qty: 1 },
    { kind: "put", strike: 535, expiry: "2026-12-18", qty: -1 },
  ];
  assert.equal(F.suggestEvent(fills, trade), "close");
});

test("suggestEvent: new contracts, same side or oversize -> adjust", () => {
  const trade = { legs };
  assert.equal(F.suggestEvent([{ kind: "put", strike: 530, expiry: "2026-12-18", qty: -1 }], trade), "adjust");
  assert.equal(F.suggestEvent([{ kind: "put", strike: 540, expiry: "2026-12-18", qty: -1 }], trade), "adjust");
  assert.equal(F.suggestEvent([{ kind: "put", strike: 540, expiry: "2026-12-18", qty: 2 }], trade), "adjust");
  assert.equal(F.suggestEvent([], trade), "adjust");
});

test("validateEdit returns only changed fields", () => {
  const orig = { executed_at: "2026-10-01T10:30:00", qty: -1, price: 3, commission: 1, event: "open" };
  const same = F.validateEdit({ date: "2026-10-01", qty: "-1", price: "3", commission: "1", event: "open" }, orig);
  assert.deepEqual(same, { ok: true, changes: {} });
  const changed = F.validateEdit({ date: "2026-10-02", qty: "-2", price: "3.1", commission: "", event: "adjust" }, orig);
  assert.deepEqual(changed.changes, { executed_at: "2026-10-02", qty: -2, price: 3.1, commission: 0, event: "adjust" });
});

test("validateEdit rejects bad input", () => {
  const orig = { executed_at: "2026-10-01", qty: 1, price: 1, commission: 0, event: "open" };
  const base = { date: "2026-10-01", qty: "1", price: "1", commission: "0", event: "open" };
  assert.equal(F.validateEdit({ ...base, qty: "0" }, orig).ok, false);
  assert.equal(F.validateEdit({ ...base, qty: "abc" }, orig).ok, false);
  assert.equal(F.validateEdit({ ...base, price: "-1" }, orig).ok, false);
  assert.equal(F.validateEdit({ ...base, commission: "-1" }, orig).ok, false);
  assert.equal(F.validateEdit({ ...base, date: "" }, orig).ok, false);
  assert.equal(F.validateEdit({ ...base, event: "bogus" }, orig).ok, false);
});

test("pendingCommissions picks fills TWS has not reported a commission for", () => {
  const fills = [
    { exec_id: "a", commission_known: 1 },
    { exec_id: "b", commission_known: 0 },
    { exec_id: "c" }, // older rows without the flag count as known
    { exec_id: "d", commission_known: false },
  ];
  assert.deepEqual(F.pendingCommissions(fills).map((f) => f.exec_id), ["b", "d"]);
  assert.deepEqual(F.pendingCommissions(null), []);
});

test("syncSummary reports counts without double counting", () => {
  assert.equal(F.syncSummary({ received: 3, new: 1, updated: 1, unchanged: 1 }),
    "Received 3 fills: 1 new, 1 commission filled in, 1 already known.");
  assert.equal(F.syncSummary({ received: 1, new: 0, updated: 0, unchanged: 1 }),
    "Received 1 fill: 0 new, 1 already known.");
  assert.equal(F.syncSummary({}), "Received 0 fills: 0 new, 0 already known.");
});
