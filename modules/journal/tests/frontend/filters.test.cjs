const test = require("node:test");
const assert = require("node:assert/strict");
const Fl = require("../../static/js/filters.js");
const C = require("../../static/js/calendar.js");

const trades = [
  { id: 1, underlying: "SPY", strategy: "iron_condor", status: "closed", opened_at: "2026-09-01",
    realized_pnl: 150, unrealized_pnl: null, return_on_risk: 50, tags: [{ kind: "tag", value: "earnings" }] },
  { id: 2, underlying: "QQQ", strategy: "bull_put_spread", status: "closed", opened_at: "2026-10-01",
    realized_pnl: -300, unrealized_pnl: null, return_on_risk: -80, tags: [] },
  { id: 3, underlying: "SPY", strategy: "calendar", status: "open", opened_at: "2026-10-20",
    realized_pnl: null, unrealized_pnl: null, return_on_risk: null, tags: [{ kind: "mistake", value: "oversized" }] },
];

test("filter by status, underlying, strategy, dates, tag", () => {
  const ids = (f) => Fl.filterTrades(trades, f).map((t) => t.id);
  assert.deepEqual(ids({}), [1, 2, 3]);
  assert.deepEqual(ids({ status: "open" }), [3]);
  assert.deepEqual(ids({ underlying: "spy" }), [1, 3]);
  assert.deepEqual(ids({ strategy: "calendar" }), [3]);
  assert.deepEqual(ids({ from: "2026-10-01" }), [2, 3]);
  assert.deepEqual(ids({ to: "2026-09-30" }), [1]);
  assert.deepEqual(ids({ tag: "OVER" }), [3]);
});

test("sort by account name", () => {
  const withAccounts = trades.map((t, i) => ({ ...t, account_name: ["Paper", "IBKR", "Roth"][i] }));
  assert.deepEqual(Fl.sortTrades(withAccounts, "account_name", "asc").map((t) => t.id), [2, 1, 3]);
});

test("sort puts nulls last both ways and does not mutate", () => {
  const copy = [...trades];
  assert.deepEqual(Fl.sortTrades(trades, "pnl", "desc").map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(Fl.sortTrades(trades, "pnl", "asc").map((t) => t.id), [2, 1, 3]);
  assert.deepEqual(Fl.sortTrades(trades, "underlying", "asc").map((t) => t.id), [2, 3, 1]);
  assert.deepEqual(trades, copy);
});

test("headline numbers", () => {
  assert.deepEqual(Fl.headline(trades), { open: 1, closed: 2, realized: -150, winRate: 50 });
  assert.deepEqual(Fl.headline([]), { open: 0, closed: 0, realized: 0, winRate: null });
});

test("calendar grid places days under their Monday", () => {
  const g = C.calendarGrid([
    { key: "2026-11-02", pnl: 100, trades: 1 }, // Monday
    { key: "2026-11-13", pnl: -50, trades: 2 }, // Friday, two weeks later
  ]);
  assert.deepEqual(g.weeks, ["2026-11-02", "2026-11-09"]);
  assert.deepEqual(g.days, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.equal(g.z[0][0], 100);
  assert.equal(g.z[4][1], -50);
  assert.equal(g.z[1][0], null);
  assert.equal(g.text[4][1], "2 trades");
  assert.deepEqual(C.calendarGrid([]).weeks, []);
});

test("bin edges include zero and cover the range", () => {
  assert.deepEqual(C.binEdges([-25, 5, 31]), [-30, -20, -10, 0, 10, 20, 30, 40]);
  assert.deepEqual(C.binEdges([]), []);
  assert.deepEqual(C.binEdges([0]), [0, 10]);
});
