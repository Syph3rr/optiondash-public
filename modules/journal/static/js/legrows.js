/* Editable leg rows used by the new-trade form and the adjust/roll/close modal. */
(function (root) {
  "use strict";
  const { el, numVal } = UI;

  const HEAD = ["Side", "Qty", "Type", "Strike", "Expiry", "Fill price", "Comm. $", ""];

  function headRow(extra = []) {
    return el("tr", {}, [...extra, ...HEAD].map((h) => el("th", {}, h)));
  }

  /**
   * opts: {side, kind, qty, strike, expiry, price, commission, hint, group, locked (existing leg:
   * type/strike/expiry fixed), removable, prefix: [cells before the side]}
   * Returns {tr, read(), peek(), draft(), values(), setValues(v), setExpiry(iso, force), group,
   * hasInput(), onChange(fn), isAttached()}
   */
  function legRow(opts = {}) {
    let side = opts.side || "buy";
    let expiryTouched = false;
    const listeners = [];
    const fire = () => listeners.forEach((fn) => fn());

    const sideBtn = el("button", { type: "button" });
    const paintSide = () => {
      sideBtn.className = `side ${side === "buy" ? "long" : "short"}`;
      sideBtn.textContent = side === "buy" ? "BUY" : "SELL";
    };
    sideBtn.addEventListener("click", () => { side = side === "buy" ? "sell" : "buy"; paintSide(); fire(); });
    paintSide();

    const qty = el("input", { type: "number", min: "0", step: "any", value: opts.qty ?? 1, style: { width: "72px" } });
    const kind = el("select", { disabled: !!opts.locked, style: { minWidth: "80px" } },
      ["call", "put", "stock"].map((k) => el("option", { value: k, selected: k === (opts.kind || "call") }, k)));
    const strike = el("input", { type: "number", min: "0", step: "any", value: opts.strike ?? "", placeholder: opts.hint || "", disabled: !!opts.locked, style: { width: "100px" } });
    const expiry = el("input", { type: "date", value: opts.expiry || "", disabled: !!opts.locked });
    const price = el("input", { type: "number", min: "0", step: "any", value: opts.price ?? "", placeholder: "0.00", style: { width: "90px" } });
    const comm = el("input", { type: "number", min: "0", step: "any", value: opts.commission ?? "", placeholder: "0", style: { width: "72px" } });
    const del = opts.removable === false ? el("span")
      : el("button", { type: "button", class: "iconbtn del", title: "Remove leg", onclick: () => { tr.remove(); fire(); } }, "✕");

    const isStock = () => kind.value === "stock";
    const syncStock = () => {
      strike.disabled = expiry.disabled = !!opts.locked || isStock();
      if (isStock()) { strike.value = ""; expiry.value = ""; }
    };
    kind.addEventListener("change", () => { syncStock(); fire(); });
    expiry.addEventListener("input", () => { expiryTouched = true; fire(); });
    [qty, strike, price, comm].forEach((n) => n.addEventListener("input", fire));
    syncStock();

    const tr = el("tr", {}, opts.prefix || [], el("td", {}, sideBtn), el("td", {}, qty), el("td", {}, kind),
      el("td", {}, strike), el("td", {}, expiry), el("td", {}, price), el("td", {}, comm),
      el("td", { class: "faint", style: { fontSize: "11px", whiteSpace: "nowrap" } }, del));

    function bad(node, message) {
      node.classList.add("bad");
      node.focus();
      throw new Error(message);
    }

    /** Validated values; throws Error with a readable message on bad input. */
    function read({ requirePrice = true } = {}) {
      [qty, strike, expiry, price, comm].forEach((n) => n.classList.remove("bad"));
      const q = numVal(qty);
      if (q === null || !(q > 0)) bad(qty, "Quantity must be a number above 0.");
      const k = kind.value;
      let s = null;
      let e = null;
      if (k !== "stock") {
        s = numVal(strike);
        if (s === null || !(s > 0)) bad(strike, "Option legs need a strike above 0.");
        e = expiry.value;
        if (!e) bad(expiry, "Option legs need an expiry date.");
      }
      const p = numVal(price);
      if (p === null && requirePrice) bad(price, "Enter the fill price (per share, e.g. 1.25).");
      if (p !== null && !(p >= 0)) bad(price, "Fill price must be 0 or more.");
      const c = numVal(comm);
      if (c !== null && !(c >= 0)) bad(comm, "Commission must be 0 or more.");
      return { side, qty: q, kind: k, strike: s, expiry: e, price: p ?? 0, commission: c ?? 0 };
    }

    /** Current values without validation, for live previews (null when incomplete). */
    function peek() {
      const q = numVal(qty), p = numVal(price), s = numVal(strike);
      if (!(q > 0) || p === null || Number.isNaN(p)) return null;
      if (kind.value !== "stock" && !(s > 0)) return null;
      return { kind: kind.value, strike: s, expiry: expiry.value || null, qty: side === "buy" ? q : -q, price: p };
    }

    /** Parsed values without validation (numbers or null), for live checks and summaries. */
    const draft = () => ({ side, qty: numVal(qty), kind: kind.value, strike: numVal(strike),
      expiry: expiry.value || null, price: numVal(price), commission: numVal(comm) });

    /** Raw input values (strings), for carrying a row's entries over to a new template. */
    const values = () => ({ kind: kind.value, strike: strike.value, expiry: expiry.value, price: price.value, commission: comm.value });

    /** Copy strike/expiry (option rows only, same kind family), price and commission. */
    function setValues(v) {
      const bothStock = (v.kind === "stock") === isStock();
      if (bothStock && !isStock() && !opts.locked) {
        if (v.strike !== "") strike.value = v.strike;
        if (v.expiry) { expiry.value = v.expiry; expiryTouched = true; }
      }
      if (v.price !== "") price.value = v.price;
      if (v.commission !== "") comm.value = v.commission;
      fire();
    }

    return {
      tr, read, peek, draft, values, setValues,
      hasInput: () => strike.value.trim() !== "" || price.value.trim() !== "",
      group: opts.group || "front",
      setExpiry(iso, force = false) {
        if (opts.locked || isStock() || (expiryTouched && !force)) return;
        expiry.value = iso || "";
      },
      onChange: (fn) => listeners.push(fn),
      isAttached: () => tr.isConnected,
    };
  }

  /** Convert a validated row into a FillIn for the API. */
  function toFill(v, legId = null) {
    const signed = v.side === "buy" ? v.qty : -v.qty;
    const base = { qty: signed, price: v.price, commission: v.commission };
    if (legId !== null) return { leg_id: legId, ...base };
    const leg = { kind: v.kind };
    if (v.kind !== "stock") { leg.strike = v.strike; leg.expiry = v.expiry; }
    return { leg, ...base };
  }

  root.LegRows = { headRow, legRow, toFill };
})(window);
