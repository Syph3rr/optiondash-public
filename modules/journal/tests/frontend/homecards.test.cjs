// Home card helpers: the month calendar, bar-list scaling and the open trades table.
const test = require("node:test");
const assert = require("node:assert/strict");
const Cal = require("../../static/js/calendar.js");
const BarList = require("../../static/js/barlist.js");
const OpenTrades = require("../../static/js/opentrades.js");

const freeze = (o) => Object.freeze(Array.isArray(o) ? o.map((x) => Object.freeze({ ...x })) : o);

// ---------------------------------------------------------------- month calendar

test("latestMonth is the month of the last close, or today's when nothing closed", () => {
  assert.deepEqual(Cal.latestMonth([{ key: "2026-09-30" }, { key: "2026-10-23" }], "2026-11-05"), { year: 2026, month: 10 });
  assert.deepEqual(Cal.latestMonth([], "2026-11-05"), { year: 2026, month: 11 });
});

test("shiftMonth crosses year ends both ways", () => {
  assert.deepEqual(Cal.shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(Cal.shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
});

test("monthGrid lays out Mon-Fri weeks with daily and weekly P&L", () => {
  const daily = freeze([
    { key: "2026-10-09", pnl: -1142.6, trades: 1 },
    { key: "2026-10-15", pnl: -185.2, trades: 1 },
    { key: "2026-10-23", pnl: 309.6, trades: 1 },
    { key: "2026-11-04", pnl: 74.08, trades: 1 },   // other month: ignored
  ]);
  const g = Cal.monthGrid(daily, 2026, 10);
  assert.equal(g.label, "October 2026");
  assert.deepEqual(g.weekdays, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  // 1 Oct 2026 is a Thursday: the first week starts Mon 28 Sep (outside the month).
  assert.equal(g.weeks[0].cells[0].iso, "2026-09-28");
  assert.equal(g.weeks[0].cells[0].inMonth, false);
  assert.equal(g.weeks[0].cells[3].day, 1);
  assert.equal(g.weeks.length, 5);
  const fri9 = g.weeks[1].cells[4];
  assert.deepEqual([fri9.iso, fri9.pnl, fri9.trades], ["2026-10-09", -1142.6, 1]);
  assert.equal(g.weeks[1].pnl, -1142.6);
  assert.equal(g.weeks[0].active, false);
  assert.equal(g.pnl, -1018.2);
  assert.deepEqual([g.trades, g.greenDays, g.redDays], [3, 1, 2]);
});

test("monthGrid shows weekends only when something closed on one, and skips weekend-only weeks", () => {
  const g = Cal.monthGrid([{ key: "2026-11-07", pnl: 10, trades: 1 }], 2026, 11); // Sat 7 Nov
  assert.equal(g.weekdays.length, 7);
  assert.equal(g.pnl, 10);
  // 1 Nov 2026 is a Sunday: with Mon-Fri only, that first week has no day of the month.
  const plain = Cal.monthGrid([], 2026, 11);
  assert.equal(plain.weekdays.length, 5);
  assert.equal(plain.weeks[0].cells[0].iso, "2026-11-02");
  assert.ok(plain.weeks.every((w) => w.cells.some((c) => c.inMonth)));
});

// ---------------------------------------------------------------- bar list

test("bar scale puts zero at the left when every value is positive", () => {
  const s = BarList.scale(freeze([{ value: 50 }, { value: 100 }]));
  assert.equal(s.zero, 0);
  assert.deepEqual(s.rows.map((r) => [r.left, r.width]), [[0, 50], [0, 100]]);
});

test("bar scale shares one zero line between gains and losses", () => {
  const s = BarList.scale(freeze([{ value: 300 }, { value: -100 }]));
  assert.equal(s.zero, 25);
  assert.deepEqual(s.rows.map((r) => [r.left, r.width]), [[25, 75], [0, 25]]);
});

test("bar scale copes with all zeros, missing values and a custom accessor, without changing input", () => {
  const rows = freeze([{ v: 0 }, { v: null }]);
  const s = BarList.scale(rows, (r) => r.v);
  assert.deepEqual(s.rows.map((r) => r.width), [0, 0]);
  assert.equal(rows[0].left, undefined);
});

// ---------------------------------------------------------------- open trades

const trade = (o) => ({ status: "open", legs: [], current: null, max_risk_override: null, cash_flow: 0, days_held: 1, pnl: null, ...o });

test("open trades: only open ones, nearest expiry first, stock-only last", () => {
  const out = OpenTrades.rows([
    trade({ id: 1, status: "closed", legs: [{ expiry: "2026-11-06", net_qty: 0 }] }),
    trade({ id: 2, legs: [{ expiry: "2026-11-20", net_qty: -3 }, { expiry: "2026-11-20", net_qty: 3 }] }),
    trade({ id: 3, legs: [{ expiry: null, net_qty: 100 }] }),
    trade({ id: 4, legs: [{ expiry: "2026-11-27", net_qty: 1 }, { expiry: "2026-11-13", net_qty: -1 }] }),
  ], "2026-11-05");
  assert.deepEqual(out.map((r) => [r.id, r.expiry, r.dte]), [[4, "2026-11-13", 8], [2, "2026-11-20", 15], [3, null, null]]);
});

test("open trades: a leg already closed does not count as the next expiry", () => {
  const legs = [{ expiry: "2026-11-06", net_qty: 0 }, { expiry: "2026-11-20", net_qty: 1 }];
  assert.equal(OpenTrades.nextExpiry(legs), "2026-11-20");
  assert.equal(OpenTrades.nextExpiry([]), null);
});

test("open trades: risk is the current max loss, else the override, else unlimited", () => {
  const [a, b, c] = OpenTrades.rows([
    trade({ id: 1, current: { max_loss: 480 }, max_risk_override: 900 }),
    trade({ id: 2, current: { max_loss: null }, max_risk_override: 900 }),
    trade({ id: 3, current: { max_loss: null } }),
  ], "2026-11-05");
  assert.deepEqual([a.risk, a.unlimited], [480, false]);
  assert.deepEqual([b.risk, b.unlimited], [900, false]);
  assert.deepEqual([c.risk, c.unlimited], [null, true]);
});

test("open trades: bad input gives no rows", () => {
  assert.deepEqual(OpenTrades.rows(null, "2026-11-05"), []);
  assert.deepEqual(OpenTrades.rows([null], "2026-11-05"), []);
});
