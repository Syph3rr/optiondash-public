const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../../static/js/format.js");

test("money signs and grouping", () => {
  assert.equal(F.money(1234.5), "+$1,234.50");
  assert.equal(F.money(-80), "−$80.00");
  assert.equal(F.money(0), "$0.00");
  assert.equal(F.money(12345.6), "+$12,346");
  assert.equal(F.money(null), "—");
  assert.equal(F.money(5, { signed: false }), "$5.00");
});

test("pct and num", () => {
  assert.equal(F.pct(31.58), "31.6%");
  assert.equal(F.pct(-2, 1, true), "−2.0%");
  assert.equal(F.pct(2, 0, true), "+2%");
  assert.equal(F.pct(undefined), "—");
  assert.equal(F.num(-1.5, 1), "−1.5");
});

test("dates", () => {
  assert.equal(F.date("2026-12-18"), "18 Dec 26");
  assert.equal(F.date("2026-12-18", false), "18 Dec");
  assert.equal(F.dateTime("2026-12-18T09:31:05"), "18 Dec 26 09:31");
  assert.equal(F.date(null), "—");
  assert.equal(F.todayIso(new Date(2026, 0, 5)), "2026-01-05");
});

test("leg labels and summary", () => {
  assert.equal(F.legLabel({ kind: "put", strike: 540, qty: -1 }), "−1 540P");
  assert.equal(F.legLabel({ kind: "stock", qty: 100 }), "+100 sh");
  const legs = [
    { kind: "put", strike: 540, expiry: "2026-12-18", net_qty: -1 },
    { kind: "put", strike: 535, expiry: "2026-12-18", net_qty: 1 },
    { kind: "call", strike: 600, expiry: "2027-01-15", net_qty: 0 },
  ];
  assert.equal(F.legsSummary(legs, "net_qty"), "−1 540P / +1 535P 18 Dec");
});

test("strategy labels, stars, escaping, sign class", () => {
  assert.equal(F.strategyLabel("bull_put_spread"), "Bull put spread");
  assert.equal(F.strategyLabel("weird_one"), "weird one");
  assert.equal(F.stars(3), "★★★☆☆");
  assert.equal(F.stars(null), "");
  assert.equal(F.escapeHtml(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  assert.equal(F.signClass(-1), "neg");
  assert.equal(F.signClass(2), "pos");
  assert.equal(F.signClass(null), "");
});
