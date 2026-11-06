const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../../static/js/engine.js");

const DAY = E.DAY_MS;
const exec = (qty, price, event = "open") => ({ qty, price, event });
const view = (legs, extra = {}) => ({ id: 1, opened_at: "2026-10-01", status: "open", legs, ...extra });
const optLeg = (kind, strike, net_qty, avg_cost, executions, expiry = "2026-10-30") =>
  ({ kind, strike, expiry, multiplier: 100, net_qty, avg_cost, executions });

test("New York 16:00 expiry handles both sides of the DST change", () => {
  // 30 Oct 2026 is still EDT (UTC-4); 6 Nov 2026 is EST (UTC-5).
  assert.equal(new Date(E.expiryMs("2026-10-30")).toISOString(), "2026-10-30T20:00:00.000Z");
  assert.equal(new Date(E.expiryMs("2026-11-06")).toISOString(), "2026-11-06T21:00:00.000Z");
  assert.equal(new Date(E.refMs({ opened_at: "2026-10-01" })).toISOString(), "2026-10-01T13:30:00.000Z");
  assert.equal(E.nyDay(Date.UTC(2026, 9, 2, 2, 0)), "2026-10-01"); // 22:00 NY the day before
});

test("current position uses net qty and average cost; flat legs are dropped", () => {
  const v = view([
    optLeg("put", 540, -1, 3.0, [exec(-1, 3.0)]),
    optLeg("put", 535, 0, 0, [exec(1, 1.8), exec(-1, 0.5, "close")]),
  ]);
  assert.deepEqual(E.positionLegs(v, "current"),
    [{ kind: "put", strike: 540, expiry: "2026-10-30", qty: -1, cost: 3.0, multiplier: 100 }]);
});

test("initial position is rebuilt from 'open' fills with a size-weighted price", () => {
  const v = view([optLeg("call", 100, 0, 0, [exec(1, 2.0), exec(3, 4.0), exec(-4, 5.0, "close")])]);
  const [l] = E.positionLegs(v, "initial");
  assert.equal(l.qty, 4);
  assert.equal(l.cost, 3.5);
});

test("request: signed qty becomes long/qty, dte counted from entry at 09:30 New York", () => {
  const v = view([optLeg("put", 540, -2, 3.0, [exec(-2, 3.0)])]);
  const legs = E.positionLegs(v, "current");
  const at = E.closeOfDayMs("2026-10-15");
  const body = E.buildRequest(v, legs, { spot: 550, ivPct: 25, atMs: at });
  assert.equal(body.model, "american");
  assert.equal(body.spot, 550);
  assert.equal(body.rate, 0.04);
  const [l] = body.legs;
  assert.deepEqual([l.kind, l.long, l.qty, l.strike, l.iv, l.premium, l.multiplier], ["put", false, 2, 540, 0.25, 3.0, 100]);
  const expectedDte = (E.expiryMs("2026-10-30") - E.refMs(v)) / DAY;
  assert.ok(Math.abs(l.dte - expectedDte) < 1e-9);
  assert.ok(Math.abs(body.at_days[0] - (at - E.refMs(v)) / DAY) < 1e-9);
});

test("stock legs carry no strike or dte; IV defaults to 30%", () => {
  const v = view([{ kind: "stock", strike: null, expiry: null, multiplier: 1, net_qty: 100, avg_cost: 98, executions: [] }]);
  const body = E.buildRequest(v, E.positionLegs(v, "current"), { spot: 100 });
  assert.deepEqual(body.legs[0], { kind: "stock", long: true, qty: 100, strike: 0, dte: 0, iv: 0.3, premium: 98, multiplier: 1, enabled: true });
});

test("a missing or non-positive spot is a clear error", () => {
  const v = view([optLeg("call", 100, 1, 2, [exec(1, 2)])]);
  assert.throws(() => E.buildRequest(v, E.positionLegs(v, "current"), { spot: 0 }), /underlying price/);
});

test("valuation dates before entry are clamped to entry", () => {
  const v = view([optLeg("call", 100, 1, 2, [exec(1, 2)])]);
  const body = E.buildRequest(v, E.positionLegs(v, "current"), { spot: 100, atMs: E.refMs(v) - 5 * DAY });
  assert.equal(body.at_days[0], 0);
});

test("default valuation date: now for open trades (clamped to first expiry), entry for closed", () => {
  const legs = [{ kind: "call", strike: 100, expiry: "2026-10-30", qty: 1, cost: 2, multiplier: 100 }];
  const open = view([], { status: "open" });
  const mid = E.closeOfDayMs("2026-10-10");
  assert.equal(E.defaultAtMs(open, legs, mid), mid);
  assert.equal(E.defaultAtMs(open, legs, E.closeOfDayMs("2027-01-01")), E.expiryMs("2026-10-30"));
  assert.equal(E.defaultAtMs(view([], { status: "closed" }), legs, mid), E.refMs(open));
});

test("price range covers the strikes and about two sigma, within bounds", () => {
  const legs = [{ kind: "put", strike: 90, expiry: "2026-10-30", qty: 1, cost: 1, multiplier: 100 }];
  assert.equal(E.autoRange(legs, 100, 20, 30), 0.16);           // strike 10% away → 0.10*1.3+0.03
  assert.equal(E.autoRange(legs, 100, 100, 365), 0.9);          // big vol → capped
  assert.equal(E.autoRange([], 100, 1, 1), 0.05);
});

test("greeksAt reads the spot column of the selected date", () => {
  const row = (v) => [[0, v, 0]];
  const res = { spot_index: 1, grid: { delta: row(1), gamma: row(2), theta: row(3), vega: row(4) } };
  assert.deepEqual(E.greeksAt(res, 0), { delta: 1, gamma: 2, theta: 3, vega: 4 });
  assert.equal(E.nearestIndex([0, 1.5, 3], 1.2), 1);
});

test("day list spans month ends and the DST change; slider day 0 is entry itself", () => {
  const days = E.dayList("2026-10-30", "2026-11-02");
  assert.deepEqual(days, ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  const v = { opened_at: "2026-10-30" };
  assert.equal(E.dayToMs(v, days, 0), E.refMs(v));
  assert.equal(E.dayToMs(v, days, 3), E.closeOfDayMs("2026-11-02"));
  assert.equal(E.dayToMs(v, days, 99), E.closeOfDayMs("2026-11-02"));
});

test("engine times are labelled in New York wall-clock time", () => {
  const v = { opened_at: "2026-10-30" };
  const toExpiry = (E.expiryMs("2026-11-06") - E.refMs(v)) / DAY;  // crosses the DST change
  assert.deepEqual(E.timesToIso(v, [0, toExpiry]), ["2026-10-30 09:30", "2026-11-06 16:00"]);
});

test("trade page prices a closed trade as opened, an open one as it stands now", () => {
  assert.equal(E.defaultWhich(view([], { status: "closed" })), "initial");
  assert.equal(E.defaultWhich(view([], { status: "open" })), "current");
  assert.equal(E.defaultWhich({}), "current");
  assert.equal(E.defaultWhich(null), "current");
});
