/* The Trades page's bulk move bar: "N selected · Move to [account] [Move]". Moving is
 * reversible, so there is no confirm: it moves, then a toast offers Undo, which puts every trade
 * back in the account it came from (one move per old account). Pure logic is in accountpick.js. */
(function (root) {
  "use strict";
  const { el, clear, toast } = UI;
  const UNDO_MS = 12000;

  const nameOf = (accounts, id) => (accounts.find((a) => a.id === id) || { name: `account ${id}` }).name;

  /** Moves the trades (all or none). Resolves to how many moved. */
  async function move(ids, accountId) {
    const r = await Api.post("/api/journal/trades/move", { trade_ids: ids, account_id: accountId });
    return r.moved;
  }

  function undoToast(accounts, plan, onDone) {
    const btn = el("button", { type: "button", class: "btn sm", style: { marginLeft: "8px" } }, "Undo");
    return (message) => {
      const node = toast(el("span", {}, message, plan.length ? btn : null), "ok", plan.length ? UNDO_MS : undefined);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        let back = 0;
        try {
          for (const g of plan) back += await move(g.trade_ids, g.account_id);
          node.remove();
          const names = [...new Set(plan.map((g) => nameOf(accounts, g.account_id)))].join(", ");
          toast(`Undone: moved ${back} back to ${names}`, "ok");
        } catch (_) {
          btn.disabled = false; // Api showed why; the user can retry
        } finally {
          await onDone();
        }
      });
    };
  }

  /**
   * Renders the bar into `bar` (hidden when nothing is selected).
   * opts: {selected: Set of ids, accounts, trades (as loaded), onDone: async () => reload,
   *        onClear: () => void}
   */
  function render(bar, { selected, accounts, trades, onDone, onClear }) {
    const ids = [...selected];
    bar.classList.toggle("hidden", !ids.length);
    if (!ids.length) { clear(bar); return; }
    const chosen = trades.filter((t) => selected.has(t.id));
    const shared = new Set(chosen.map((t) => t.account_id));
    const firstOther = accounts.find((a) => !(shared.size === 1 && shared.has(a.id))) || accounts[0];
    const target = el("select", { class: "inp", "aria-label": "Account to move the selected trades to" },
      accounts.map((a) => el("option", { value: a.id, selected: firstOther && a.id === firstOther.id }, AccountPick.optionLabel(a))));
    const go = el("button", { type: "button", class: "btn primary sm" }, "Move");
    go.addEventListener("click", async () => {
      const accountId = Number(target.value);
      const before = chosen.map((t) => ({ id: t.id, account_id: t.account_id }));
      go.disabled = true;
      try {
        const moved = await move(ids, accountId);
        const plan = AccountPick.undoPlan(before, ids, accountId);
        onClear();
        undoToast(accounts, plan, onDone)(AccountPick.moveMessage(moved, nameOf(accounts, accountId)));
      } catch (_) {
        go.disabled = false; // Api showed the server's message
        return;
      }
      await onDone();
    });
    clear(bar,
      el("b", {}, AccountPick.selectedLabel(ids.length)),
      el("span", { class: "faint" }, "·"),
      el("span", { class: "lbl" }, "Move to"), target, go,
      el("button", { type: "button", class: "btn sm", onclick: onClear }, "Clear"));
  }

  root.BulkMove = { render };
})(window);
