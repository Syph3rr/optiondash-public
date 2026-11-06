/* Formatting helpers. Pure: no DOM. Works in the browser (window.Fmt) and in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Fmt = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MINUS = "−";

  const STRATEGY_LABELS = {
    long_call: "Long call", long_put: "Long put", short_call: "Short call", short_put: "Short put",
    covered_call: "Covered call", cash_secured_put: "Cash-secured put",
    bull_call_spread: "Bull call spread", bear_put_spread: "Bear put spread",
    bull_put_spread: "Bull put spread", bear_call_spread: "Bear call spread",
    iron_condor: "Iron condor", iron_butterfly: "Iron butterfly", long_butterfly: "Butterfly",
    broken_wing_butterfly: "Broken-wing butterfly", long_straddle: "Long straddle",
    short_straddle: "Short straddle", long_strangle: "Long strangle", short_strangle: "Short strangle",
    calendar: "Calendar", double_calendar: "Double calendar", diagonal: "Diagonal",
    ratio_spread: "Ratio spread", jade_lizard: "Jade lizard", stock: "Stock", custom: "Custom",
  };

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function grouped(n, digits) {
    return Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  /** +$1,234.56 / −$80.00. Null-ish gives an em dash. */
  function money(v, opts = {}) {
    if (!isNum(v)) return "—";
    const digits = opts.digits ?? (Math.abs(v) >= 10000 ? 0 : 2);
    const sign = v < 0 ? MINUS : opts.signed === false || v === 0 ? "" : "+";
    return `${sign}$${grouped(v, digits)}`;
  }

  function plainMoney(v, digits = 2) {
    if (!isNum(v)) return "—";
    return `${v < 0 ? MINUS : ""}$${grouped(v, digits)}`;
  }

  function pct(v, digits = 1, signed = false) {
    if (!isNum(v)) return "—";
    const sign = v < 0 ? MINUS : signed && v > 0 ? "+" : "";
    return `${sign}${Math.abs(v).toFixed(digits)}%`;
  }

  function num(v, digits = 2) {
    if (!isNum(v)) return "—";
    return `${v < 0 ? MINUS : ""}${grouped(v, digits)}`;
  }

  /** Price with no trailing zeros beyond cents: 540 -> "540", 537.5 -> "537.5". */
  function strike(v) {
    if (!isNum(v)) return "";
    return String(Math.round(v * 100) / 100);
  }

  function parseIso(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return { y, m, d };
  }

  /** "2026-12-18" -> "18 Dec 26"; with year=false "18 Dec". */
  function date(iso, year = true) {
    const p = parseIso(iso);
    if (!p) return "—";
    const base = `${p.d} ${MONTHS[p.m - 1]}`;
    return year ? `${base} ${String(p.y).slice(2)}` : base;
  }

  function dateTime(iso) {
    if (!iso) return "—";
    const t = String(iso).length > 10 ? String(iso).slice(11, 16) : "";
    return t ? `${date(iso)} ${t}` : date(iso);
  }

  function signedQty(q) {
    if (!isNum(q)) return "";
    const n = Math.round(q * 1e6) / 1e6;
    return n > 0 ? `+${n}` : n < 0 ? `${MINUS}${Math.abs(n)}` : "0";
  }

  /** One leg: "−1 540P" (kind letter after strike), stock: "+100 sh". */
  function legLabel(leg, qtyKey = "qty") {
    const q = signedQty(leg[qtyKey]);
    if (leg.kind === "stock") return `${q} sh`;
    return `${q} ${strike(leg.strike)}${leg.kind === "call" ? "C" : "P"}`;
  }

  /** Legs grouped by expiry: "−1 540P / +1 535P 18 Dec". */
  function legsSummary(legs, qtyKey = "qty") {
    const groups = new Map();
    for (const leg of legs || []) {
      if (!isNum(leg[qtyKey]) || leg[qtyKey] === 0) continue;
      const key = leg.kind === "stock" ? "" : leg.expiry || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(leg);
    }
    const keys = [...groups.keys()].sort();
    return keys
      .map((k) => {
        const legsText = groups.get(k).map((l) => legLabel(l, qtyKey)).join(" / ");
        return k ? `${legsText} ${date(k, false)}` : legsText;
      })
      .join(" · ");
  }

  function strategyLabel(id) {
    return STRATEGY_LABELS[id] || String(id || "").replace(/_/g, " ");
  }

  function stars(n) {
    if (!isNum(n) || n < 1) return "";
    const k = Math.max(1, Math.min(5, Math.round(n)));
    return "★".repeat(k) + "☆".repeat(5 - k);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function signClass(v) {
    return !isNum(v) || v === 0 ? "" : v > 0 ? "pos" : "neg";
  }

  /** Local "YYYY-MM-DD" for today (date inputs want local, not UTC). */
  function todayIso(now = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  }

  return {
    STRATEGY_LABELS, money, plainMoney, pct, num, strike, date, dateTime, signedQty, legLabel,
    legsSummary, strategyLabel, stars, escapeHtml, signClass, todayIso, isNum,
  };
});
