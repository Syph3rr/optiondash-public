/* Account choices on the Trades page, the New trade form, the trade page and the IBKR import:
 * which account a new trade or an imported fill goes to, how a bulk move is undone, and labels.
 * Pure. window.AccountPick / Node. Accounts are GET /api/journal/accounts items. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AccountPick = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPE_LABEL = { ibkr: "IBKR", paper: "Paper", other: "Other" };

  const list = (accounts) => (Array.isArray(accounts) ? accounts : []);
  const byId = (a, b) => a.id - b.id;

  function typeLabel(type) {
    return TYPE_LABEL[type] || String(type);
  }

  /** "Roth (IBKR)"; just "Paper" when the name already is the type. */
  function optionLabel(account) {
    const type = typeLabel(account.type);
    return account.name.toLowerCase() === type.toLowerCase() ? account.name : `${account.name} (${type})`;
  }

  /** The server's default: the first IBKR account by lowest id, else the lowest id. */
  function serverDefault(accounts) {
    const sorted = [...list(accounts)].sort(byId);
    const ibkr = sorted.find((a) => a.type === "ibkr");
    return ibkr ? ibkr.id : sorted.length ? sorted[0].id : null;
  }

  /** A new trade's account: the only selected account when the filter picks exactly one, else the default. */
  function defaultAccountId(accounts, selected) {
    const known = new Set(list(accounts).map((a) => a.id));
    const chosen = (selected || []).filter((id) => known.has(id));
    return chosen.length === 1 ? chosen[0] : serverDefault(accounts);
  }

  /** Where new trades made from these fills go, as the importer decides it:
   *  the IBKR account whose broker_ref is the fills' account number, else the default. */
  function accountForFills(accounts, fills) {
    const numbers = [...new Set((fills || []).map((f) => String((f && f.account) || "").trim().toUpperCase()).filter(Boolean))];
    if (numbers.length > 1) return { accountId: null, number: "", matched: false, mixed: true };
    const number = numbers[0] || "";
    const match = number && [...list(accounts)].sort(byId)
      .find((a) => a.type === "ibkr" && String(a.broker_ref || "").toUpperCase() === number);
    return { accountId: match ? match.id : serverDefault(accounts), number, matched: Boolean(match), mixed: false };
  }

  /** One line for the import panel: which account a new trade from these fills goes to, and why. */
  function fillDestination(accounts, fills) {
    const r = accountForFills(accounts, fills);
    if (r.mixed) return "These fills come from two IBKR accounts; assign each account's fills on their own";
    const account = list(accounts).find((a) => a.id === r.accountId);
    if (!account) return "";
    if (r.matched) return `Goes to ${account.name} (${r.number})`;
    if (r.number) return `Goes to ${account.name} (default; no account has broker ref ${r.number})`;
    return `Goes to ${account.name} (default)`;
  }

  /** Moves that put the moved trades back: [{account_id, trade_ids}], grouped by old account.
   *  `before` holds each trade's account before the move; trades already in `target` are left out. */
  function undoPlan(before, movedIds, target) {
    const moved = new Set(movedIds || []);
    const groups = new Map();
    for (const t of before || []) {
      if (!moved.has(t.id) || t.account_id === target) continue;
      if (!groups.has(t.account_id)) groups.set(t.account_id, []);
      groups.get(t.account_id).push(t.id);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0])
      .map(([account_id, ids]) => ({ account_id, trade_ids: [...ids].sort((a, b) => a - b) }));
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const moveMessage = (n, name) => `Moved ${plural(n, "trade")} to ${name}`;
  const selectedLabel = (n) => `${n} selected`;

  /** The selected ids that are still visible (a new Set). */
  function pruneSelection(selected, visibleIds) {
    const visible = new Set(visibleIds || []);
    return new Set([...(selected || [])].filter((id) => visible.has(id)));
  }

  /** "none" | "some" | "all" of the visible rows are selected. */
  function selectAllState(selected, visibleIds) {
    const n = (visibleIds || []).filter((id) => selected.has(id)).length;
    if (!n) return "none";
    return n === visibleIds.length ? "all" : "some";
  }

  return { TYPE_LABEL, typeLabel, optionLabel, defaultAccountId, accountForFills, fillDestination,
    undoPlan, moveMessage, selectedLabel, pruneSelection, selectAllState };
});
