/* Rules for fills against an existing position. Pure: no DOM. window.Fills / Node.
 * Legs: [{id, kind, strike, expiry, net_qty}]. Fills: [{leg_id?, leg?, qty (signed)}]. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Fills = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EPS = 1e-9;
  /** Events that may only reduce what is open, never open or reverse it. */
  const REDUCING = new Set(["close", "expire", "assign"]);
  const EVENTS = ["open", "adjust", "roll", "close", "expire", "assign"];
  /** Events offered for fills after the opening, as [value, label] for a select. */
  const LATER_EVENTS = [["close", "Close"], ["expire", "Expire"], ["assign", "Assignment / exercise"],
    ["adjust", "Adjust"], ["roll", "Roll"]];

  const describe = (l) => (l.kind === "stock" ? "stock"
    : `${Math.round(l.strike * 100) / 100}${l.kind === "call" ? "C" : "P"} ${l.expiry}`);

  /** Sum fills per existing leg id. */
  function totalsByLeg(fills) {
    const out = new Map();
    for (const f of fills || []) {
      if (f.leg_id === undefined || f.leg_id === null) continue;
      out.set(f.leg_id, (out.get(f.leg_id) || 0) + f.qty);
    }
    return out;
  }

  /**
   * Check fills for an event. Returns {errors: [msg], flips: [msg]}.
   * close/expire/assign: each existing leg's fills must be on the opposite side and no larger
   * than what is open, and no new legs may be opened. adjust/roll: flipping through zero is
   * allowed but listed in `flips` so the UI can ask first.
   */
  function checkFills(event, legs, fills) {
    const errors = [];
    const flips = [];
    const byId = new Map((legs || []).map((l) => [l.id, l]));
    for (const [legId, qty] of totalsByLeg(fills)) {
      const leg = byId.get(legId);
      if (!leg) { errors.push(`Leg #${legId} is not part of this trade.`); continue; }
      const open = leg.net_qty;
      const after = open + qty;
      const opposite = Math.abs(open) > EPS && Math.sign(qty) === -Math.sign(open);
      const flipped = Math.abs(open) > EPS && Math.abs(after) > EPS && Math.sign(after) !== Math.sign(open);
      if (REDUCING.has(event)) {
        if (Math.abs(open) < EPS) errors.push(`${describe(leg)} is already flat; nothing to ${event}.`);
        else if (!opposite) errors.push(`${describe(leg)}: a ${event} must ${open > 0 ? "sell" : "buy"} to reduce the position.`);
        else if (Math.abs(qty) > Math.abs(open) + EPS) errors.push(`${describe(leg)}: only ${Math.abs(open)} open, cannot ${event} ${Math.abs(qty)}.`);
      } else if (flipped) {
        flips.push(`${describe(leg)} goes from ${open} to ${Math.round(after * 1e6) / 1e6}.`);
      }
    }
    if (REDUCING.has(event) && (fills || []).some((f) => f.leg)) {
      errors.push(`A ${event} cannot open new legs. Use Roll or Adjust for that.`);
    }
    return { errors, flips };
  }

  /**
   * Which open option legs can be expired. Only legs whose expiry is strictly before `today`
   * count; legs expiring today are listed separately (they may still trade). Groups are per
   * expiry date, oldest first.
   */
  function expiryPlan(legs, today) {
    const open = (legs || []).filter((l) => l.kind !== "stock" && l.expiry && Math.abs(l.net_qty) > EPS);
    const groups = new Map();
    for (const l of open.filter((x) => x.expiry < today)) {
      if (!groups.has(l.expiry)) groups.set(l.expiry, []);
      groups.get(l.expiry).push(l);
    }
    return {
      groups: [...groups.keys()].sort().map((expiry) => ({ expiry, legs: groups.get(expiry) })),
      today: open.filter((l) => l.expiry === today),
    };
  }

  const sameContract = (fill, leg) => fill.kind === leg.kind
    && (fill.kind === "stock" || (Math.abs(fill.strike - leg.strike) < EPS && fill.expiry === leg.expiry));

  /**
   * Default event for IBKR fills going into an existing trade: "close" when every fill is on
   * the opposite side of an open leg of the same contract (and no larger), else "adjust".
   */
  function suggestEvent(fills, trade) {
    const legs = (trade && trade.legs) || [];
    if (!fills || !fills.length) return "adjust";
    const totals = new Map();
    for (const f of fills) {
      const leg = legs.find((l) => Math.abs(l.net_qty) > EPS && sameContract(f, l));
      if (!leg || Math.sign(f.qty) !== -Math.sign(leg.net_qty)) return "adjust";
      totals.set(leg.id, (totals.get(leg.id) || 0) + f.qty);
    }
    for (const [id, qty] of totals) {
      const leg = legs.find((l) => l.id === id);
      if (Math.abs(qty) > Math.abs(leg.net_qty) + EPS) return "adjust";
    }
    return "close";
  }

  /**
   * Validate an edited fill. Input values are raw strings from the form plus the original
   * execution; returns {ok: true, changes} (only changed fields) or {ok: false, error}.
   */
  function validateEdit(raw, original) {
    const num = (s) => (String(s ?? "").trim() === "" ? null : Number(s));
    const qty = num(raw.qty), price = num(raw.price), commission = num(raw.commission);
    if (qty === null || !Number.isFinite(qty) || qty === 0) return { ok: false, error: "Quantity must be a non-zero number (+ bought, − sold)." };
    if (Math.abs(qty) >= 1e6) return { ok: false, error: "Quantity is too large." };
    if (price === null || !Number.isFinite(price) || price < 0) return { ok: false, error: "Price must be 0 or more." };
    if (commission !== null && (!Number.isFinite(commission) || commission < 0)) return { ok: false, error: "Commission must be 0 or more." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || ""))) return { ok: false, error: "Pick the date of the fill." };
    if (!EVENTS.includes(raw.event)) return { ok: false, error: "Pick an event." };
    const changes = {};
    if (raw.date !== String(original.executed_at).slice(0, 10)) changes.executed_at = raw.date;
    if (qty !== original.qty) changes.qty = qty;
    if (price !== original.price) changes.price = price;
    if ((commission ?? 0) !== original.commission) changes.commission = commission ?? 0;
    if (raw.event !== original.event) changes.event = raw.event;
    return { ok: true, changes };
  }

  /** IBKR fills whose commission TWS had not reported yet (stored as 0 until a later sync). */
  function pendingCommissions(fills) {
    return (fills || []).filter((f) => f && (f.commission_known === 0 || f.commission_known === false));
  }

  /** Toast text for a sync's counts ({received, new, updated, unchanged}); nothing double-counted. */
  function syncSummary(r) {
    const n = (x) => (Number.isFinite(x) ? x : 0);
    const parts = [`${n(r.new)} new`];
    if (n(r.updated)) parts.push(`${n(r.updated)} commission${n(r.updated) === 1 ? "" : "s"} filled in`);
    parts.push(`${n(r.unchanged)} already known`);
    return `Received ${n(r.received)} fill${n(r.received) === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  }

  return { checkFills, expiryPlan, suggestEvent, validateEdit, pendingCommissions, syncSummary, EVENTS, LATER_EVENTS, REDUCING };
});
