/* Trade page actions: adjust/roll/close, expire, marks, deleting fills and marks. */
(function (root) {
  "use strict";
  const { el, field, numVal, modal, confirmModal, toast } = UI;

  const openLegs = (view) => view.legs.filter((l) => Math.abs(l.net_qty) > 1e-9);

  function legName(l) {
    return l.kind === "stock" ? "Stock" : `${Fmt.strike(l.strike)}${l.kind === "call" ? "C" : "P"} ${Fmt.date(l.expiry)}`;
  }

  /**
   * Adjust / roll / close: existing legs prefilled to close; new legs can be added.
   * "Save & add another" saves, then reopens on the updated trade (remaining qty prefilled)
   * keeping the event and date, for logging several dated partial closes in a row.
   */
  function adjust(view, reload, defaultEvent = "close", defaultDate = Fmt.todayIso()) {
    const event = el("select", { class: "inp" }, Fills.LATER_EVENTS.map(([v, label]) => el("option", { value: v, selected: v === defaultEvent }, label)));
    const date = el("input", { type: "date", class: "inp", value: defaultDate });
    const existing = openLegs(view).map((l) => {
      const include = el("input", { type: "checkbox", checked: true });
      const row = LegRows.legRow({
        side: l.net_qty > 0 ? "sell" : "buy", qty: Math.abs(l.net_qty), kind: l.kind, strike: l.strike,
        expiry: l.expiry, locked: true, removable: false,
        prefix: [el("td", {}, include), el("td", { class: "num", style: { whiteSpace: "nowrap" } },
          `${Fmt.signedQty(l.net_qty)} ${legName(l)}`)],
      });
      return { leg: l, include, row };
    });
    const newRows = [];
    const body = el("tbody", {}, existing.map((e) => e.row.tr));
    const addLeg = () => {
      const r = LegRows.legRow({ side: "sell", kind: view.legs[0] ? view.legs[0].kind : "call", qty: 1,
        prefix: [el("td", {}), el("td", { class: "faint" }, "new")] });
      newRows.push(r);
      body.append(r.tr);
    };

    const errBox = el("div", { class: "form-error hidden", role: "alert" });
    const showErr = (msg) => { errBox.textContent = msg; errBox.classList.remove("hidden"); return false; };

    const content = el("div", { style: { display: "grid", gap: "12px" } },
      errBox,
      el("div", { class: "row" }, field("Event", event), field("Date", date),
        el("span", { class: "note", style: { maxWidth: "380px" } },
          "Existing legs are prefilled to close fully; change the qty for a partial close, or untick a leg to leave it. Add new legs for a roll or adjustment.")),
      el("div", { class: "table-wrap" }, el("table", { class: "t" }, el("thead", {}, LegRows.headRow(["", "Leg"])), body)),
      el("div", {}, el("button", { type: "button", class: "btn sm", onclick: addLeg }, "+ Add new leg")));

    /** Validate and post; resolves the updated trade view, or false (error shown in the dialog). */
    async function submit() {
      errBox.classList.add("hidden");
      let fills;
      try {
        if (!date.value) throw new Error("Pick the date of these fills.");
        fills = [
          ...existing.filter((e) => e.include.checked).map((e) => LegRows.toFill(e.row.read(), e.leg.id)),
          ...newRows.filter((r) => r.isAttached()).map((r) => LegRows.toFill(r.read())),
        ];
        if (!fills.length) throw new Error("Nothing to save: tick a leg or add a new one.");
      } catch (err) {
        return showErr(err.message);
      }
      const check = Fills.checkFills(event.value, view.legs, fills);
      if (check.errors.length) return showErr(check.errors.join("\n"));
      if (check.flips.length) {
        const go = await confirmModal(`This ${event.value} reverses a position:\n${check.flips.join("\n")}\nSave anyway?`,
          { title: "Reverse a position?", confirmLabel: "Save anyway", kind: "primary" });
        if (!go) return false;
      }
      let updated;
      try {
        // quiet: the server's message (e.g. an over-close 400) shows once, inside the dialog.
        updated = await Api.post(`/api/journal/trades/${view.id}/events`, { event: event.value, executed_at: date.value, fills }, { quiet: true });
      } catch (err) {
        return showErr(err.message);
      }
      toast("Fills saved.", "ok");
      await reload();
      return updated;
    }

    async function saveAndAddAnother() {
      const updated = await submit();
      if (!updated) return false;
      if (!openLegs(updated).length) toast("Nothing is left open on this trade.");
      // Reopen once this dialog has closed.
      else setTimeout(() => adjust(updated, reload, event.value, date.value), 0);
      return true;
    }

    modal({
      title: "Adjust / roll / close", body: content,
      actions: [
        { label: "Save & add another", onClick: saveAndAddAnother },
        { label: "Save fills", kind: "primary", onClick: async () => (await submit()) !== false },
      ],
    });
  }

  const legList = (legs) => legs.map((l) => `${Fmt.signedQty(l.net_qty)} ${legName(l)}`).join(", ");

  /**
   * Close option legs that expired before today at $0: one 'expire' event per expiry date,
   * dated that expiry. Legs expiring today are left alone (they may still trade).
   */
  async function expireWorthless(view, reload) {
    const plan = Fills.expiryPlan(view.legs, Fmt.todayIso());
    const todayNote = plan.today.length
      ? `${legList(plan.today)} expires today — log it after the close.` : "";
    if (!plan.groups.length) {
      toast(todayNote || "No open option legs have expired yet. Use Adjust / Roll / Close for anything else.");
      return;
    }
    const lines = plan.groups.map((g) => `${Fmt.date(g.expiry)}: ${legList(g.legs)}`);
    const ok = await confirmModal(`Close at $0.00, dated each leg's expiry?\n${lines.join("\n")}${todayNote ? `\n\nLeft open: ${todayNote}` : ""}`,
      { title: "Expire worthless", confirmLabel: "Expire", kind: "primary" });
    if (!ok) return;
    for (const g of plan.groups) {
      const fills = g.legs.map((l) => ({ leg_id: l.id, qty: -l.net_qty, price: 0, commission: 0 }));
      await Api.post(`/api/journal/trades/${view.id}/events`, { event: "expire", executed_at: g.expiry, fills });
    }
    toast(`Expired legs closed (${plan.groups.length} expiry date${plan.groups.length === 1 ? "" : "s"}).`, "ok");
    await reload();
  }

  /** Edit one fill in place: date, signed qty, price, commission, event. */
  function editExecution(exec, reload) {
    const date = el("input", { type: "date", class: "inp", value: String(exec.executed_at).slice(0, 10) });
    const qty = el("input", { type: "number", class: "inp", step: "any", value: exec.qty });
    const price = el("input", { type: "number", class: "inp", step: "any", min: "0", value: exec.price });
    const comm = el("input", { type: "number", class: "inp", step: "any", min: "0", value: exec.commission });
    const event = el("select", { class: "inp" }, Fills.EVENTS.map((v) => el("option", { value: v, selected: v === exec.event }, v)));
    const errBox = el("div", { class: "form-error hidden", role: "alert" });
    const content = el("div", { style: { display: "grid", gap: "12px" } }, errBox,
      el("div", { class: "row" }, field("Date", date), field("Event", event)),
      el("div", { class: "row" }, field("Qty (+ bought, − sold)", qty), field("Price / share", price), field("Commission $", comm)),
      exec.ibkr_exec_id ? el("div", { class: "note" }, "This fill came from IBKR. Edits here are kept; a later sync will not overwrite them.") : null);
    modal({
      title: "Edit fill", body: content, narrow: true,
      actions: [{ label: "Save", kind: "primary", onClick: async () => {
        errBox.classList.add("hidden");
        const r = Fills.validateEdit({ date: date.value, qty: qty.value, price: price.value, commission: comm.value, event: event.value }, exec);
        const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove("hidden"); return false; };
        if (!r.ok) return fail(r.error);
        if (!Object.keys(r.changes).length) return true;
        try {
          await Api.patch(`/api/journal/executions/${exec.id}`, r.changes, { quiet: true });
        } catch (err) {
          return fail(err.message);
        }
        toast("Fill updated.", "ok");
        await reload();
        return true;
      } }],
    });
  }

  /** Mark-to-market: per-leg quotes add up to the position value (editable). */
  function addMark(view, reload) {
    const legs = openLegs(view);
    if (!legs.length) {
      toast("This trade has no open position to mark.");
      return;
    }
    const date = el("input", { type: "date", class: "inp", value: Fmt.todayIso() });
    const spot = el("input", { type: "number", class: "inp", step: "any", min: "0", placeholder: "optional" });
    const total = el("input", { type: "number", class: "inp", step: "any", placeholder: "−50.00" });
    const quotes = legs.map((l) => ({ l, input: el("input", { type: "number", class: "inp", step: "any", min: "0", placeholder: "mid", style: { width: "100px" } }) }));
    const recompute = () => {
      const vals = quotes.map((q) => numVal(q.input));
      if (vals.some((v) => v === null || Number.isNaN(v))) return;
      const sum = quotes.reduce((s, q, i) => s + q.l.net_qty * q.l.multiplier * vals[i], 0);
      total.value = (Math.round(sum * 100) / 100).toFixed(2);
    };
    quotes.forEach((q) => q.input.addEventListener("input", recompute));

    const content = el("div", { style: { display: "grid", gap: "12px" } },
      el("div", { class: "row" }, field("Date", date), field("Underlying price", spot)),
      el("table", { class: "t" }, el("thead", {}, el("tr", {}, el("th", {}, "Open leg"), el("th", {}, "Quote / share"))),
        el("tbody", {}, quotes.map((q) => el("tr", {}, el("td", { class: "num" }, `${Fmt.signedQty(q.l.net_qty)} ${legName(q.l)}`), el("td", {}, q.input))))),
      field("Position value $ (negative when short)", total),
      el("div", { class: "note" }, "Value of what is still open if closed now. A short spread quoted at 0.50 is −50; a long call worth 3.20 is +320. Unrealised P&L = cash so far + this value."));

    modal({
      title: "Add mark", body: content, narrow: true,
      actions: [{ label: "Save mark", kind: "primary", onClick: async () => {
        const v = numVal(total);
        if (v === null || Number.isNaN(v)) throw new Error("Enter the position value, or a quote for every leg.");
        const s = numVal(spot);
        if (Number.isNaN(s) || (s !== null && s <= 0)) throw new Error("Underlying price must be above 0, or left blank.");
        if (!date.value) throw new Error("Pick the date of this mark.");
        await Api.post(`/api/journal/trades/${view.id}/marks`, { marked_at: date.value, position_value: v, underlying_price: s });
        toast("Mark saved.", "ok");
        await reload();
        return true;
      } }],
    });
  }

  async function deleteExecution(exec, reload) {
    const ok = await confirmModal(`Delete the ${exec.event} fill of ${Fmt.signedQty(exec.qty)} @ ${Fmt.num(exec.price)} on ${Fmt.date(exec.executed_at)}? A leg with no fills left is removed too.`,
      { title: "Delete fill" });
    if (!ok) return;
    await Api.del(`/api/journal/executions/${exec.id}`);
    toast("Fill deleted.", "ok");
    await reload();
  }

  async function deleteMark(mark, reload) {
    const ok = await confirmModal(`Delete the mark from ${Fmt.date(mark.marked_at)}?`, { title: "Delete mark" });
    if (!ok) return;
    await Api.del(`/api/journal/marks/${mark.id}`);
    await reload();
  }

  root.TradeActions = { adjust, expireWorthless, editExecution, addMark, deleteExecution, deleteMark, legName, openLegs };
})(window);
