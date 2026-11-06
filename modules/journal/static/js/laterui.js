/* "Later closes & adjustments" on the New trade form: the DOM around LaterFills.
 * Each block is one dated event with a row per opening leg, prefilled to close what is
 * still open; edit the qty for a partial close. */
(function (root) {
  "use strict";
  const { el, clear } = UI;

  const legName = (l) => (l.kind === "stock" ? "Stock"
    : `${Fmt.strike(l.strike)}${l.kind === "call" ? "C" : "P"} ${Fmt.date(l.expiry)}`);

  /**
   * Mount the section into `host`. opts.onChange() runs after any edit.
   * Returns {refresh(drafts), read(openedAt) -> events (throws Error), realised() -> $ | null, count()}.
   */
  function mount(host, opts = {}) {
    let legs = null;       // opening legs the blocks were last fitted to (LaterFills.openingLegs)
    let ready = false;     // are the opening rows above complete right now?
    let signature = "";
    let blocks = [];       // [{node, event, date, rows: [{key, include, row, prefill}]}]

    const list = el("div", { class: "later-list" });
    const summary = el("div", { class: "note later-summary" });
    const hint = el("span", { class: "note" }, "Fill in the opening legs' strikes and expiries first.");
    const addBtn = el("button", { type: "button", class: "btn sm", onclick: () => addBlock() }, "+ Add close");
    host.append(list, el("div", { class: "card-b row" }, addBtn, hint, el("span", { class: "grow" })), summary);

    const changed = () => { paintSummary(); if (opts.onChange) opts.onChange(); };

    /** Blocks as plain data (see LaterFills). */
    function snapshot() {
      return blocks.map((b) => ({
        event: b.event.value,
        date: b.date.value,
        fills: b.rows.map((r) => {
          const d = r.row.draft();
          return { key: r.key, include: r.include.checked, side: d.side, qty: d.qty, price: d.price,
            commission: d.commission, auto: d.qty === r.prefill.qty && d.side === r.prefill.side };
        }),
      }));
    }

    function buildRow(leg, data) {
      const include = el("input", { type: "checkbox", checked: data.include, "aria-label": `Include ${legName(leg)}` });
      include.addEventListener("change", changed);
      const row = LegRows.legRow({
        side: data.side, qty: data.qty, kind: leg.kind, strike: leg.strike, expiry: leg.expiry,
        price: data.price, commission: data.commission, locked: true, removable: false,
        prefix: [el("td", {}, include), el("td", { class: "num", style: { whiteSpace: "nowrap" } }, legName(leg))],
      });
      row.onChange(changed);
      // An auto row stays auto until its qty or side is edited by hand.
      const prefill = data.auto ? { side: data.side, qty: data.qty } : { side: null, qty: null };
      return { key: leg.key, include, row, prefill };
    }

    function buildBlock(data) {
      const event = el("select", { class: "inp" },
        Fills.LATER_EVENTS.map(([v, label]) => el("option", { value: v, selected: v === data.event }, label)));
      const date = el("input", { type: "date", class: "inp", value: data.date || "" });
      [event, date].forEach((n) => n.addEventListener("change", changed));
      const rows = legs.map((leg, i) => buildRow(leg, data.fills[i]));
      const block = { event, date, rows, node: null };
      const remove = el("button", { type: "button", class: "iconbtn del", title: "Remove this event",
        onclick: () => { blocks = blocks.filter((b) => b !== block); block.node.remove(); changed(); } }, "✕");
      block.node = el("div", { class: "later-block" },
        el("div", { class: "card-b row" }, UI.field("Event", event), UI.field("Date", date),
          el("span", { class: "grow" }), remove),
        el("div", { class: "table-wrap" }, el("table", { class: "t" },
          el("thead", {}, LegRows.headRow(["", "Leg"])), el("tbody", {}, rows.map((r) => r.row.tr)))));
      return block;
    }

    function render(data) {
      blocks = data.map(buildBlock);
      clear(list, blocks.map((b) => b.node));
    }

    function addBlock() {
      if (!ready) return;
      const fills = LaterFills.newBlockRows(legs, snapshot());
      const block = buildBlock({ event: "close", date: "", fills });
      blocks = [...blocks, block];
      list.append(block.node);
      block.date.focus();
      changed();
    }

    function paintSummary() {
      if (!legs || !blocks.length) { clear(summary); return; }
      const lines = LaterFills.ladder(legs, snapshot()).map((s, i) =>
        el("div", {}, `${legName(legs[i])}: open ${s.steps.map(Fmt.signedQty).join(" → ")}`));
      clear(summary, lines);
    }

    /** Called whenever the opening rows change; refits the blocks when the legs did. */
    function refresh(drafts) {
      const next = LaterFills.openingLegs(drafts);
      ready = next !== null;
      addBtn.disabled = !ready;
      hint.classList.toggle("hidden", ready);
      if (!ready) return;
      const sig = JSON.stringify(next.map((l) => [l.key, l.qty]));
      if (sig === signature) { legs = next; paintSummary(); return; }  // prices may differ
      const data = blocks.length ? LaterFills.refit(next, snapshot(), legs) : [];
      signature = sig;
      legs = next;
      render(data);
      paintSummary();
    }

    /** The validated `events` for the create payload. */
    function read(openedAt) {
      if (!blocks.length) return [];
      if (!ready) throw new Error("Finish the opening legs before saving later closes.");
      const data = snapshot();
      const { errors } = LaterFills.validate(legs, data, openedAt);
      if (errors.length) throw new Error(errors.join("\n"));
      return LaterFills.buildEvents(legs, data);
    }

    const realised = () => (ready && blocks.length ? LaterFills.realised(legs, snapshot()) : null);

    return { refresh, read, realised, count: () => blocks.length };
  }

  root.LaterUI = { mount };
})(window);
