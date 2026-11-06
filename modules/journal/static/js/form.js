/* New trade form. */
(function () {
  "use strict";
  const { el, clear, $, stat, numVal, toast } = UI;

  let rows = [];
  let journal = null;
  let later = null;
  let saving = false;

  const live = () => rows.filter((r) => r.isAttached());
  const contracts = () => Math.max(1, Math.round(numVal($("#contracts")) || 1));

  function applyTemplate(id) {
    const n = contracts();
    const front = $("#exp-front").value;
    const back = $("#exp-back").value;
    rows = Strategies.template(id).map((t) => LegRows.legRow({
      side: t.side, kind: t.kind, qty: t.ratio * n, hint: t.hint, group: t.group,
      expiry: t.kind === "stock" ? "" : t.group === "back" ? back : front,
    }));
    rows.forEach((r) => r.onChange(updatePreview));
    $("#exp-back-wrap").classList.toggle("hidden", !Strategies.usesTwoExpiries(id));
    clear($("#legs tbody"), rows.map((r) => r.tr));
    updatePreview();
  }

  /** Ask before a strategy change replaces legs the user typed. Resolves keep|fresh|cancel. */
  function askTemplateChange(next) {
    return new Promise((resolve) => {
      let answer = "cancel";
      UI.modal({
        title: "Change strategy?", narrow: true,
        body: el("p", { style: { margin: 0 } },
          `Switching to ${Fmt.strategyLabel(next)} replaces the leg rows. Keep the strikes, expiries and prices you typed (matched by row position), or start fresh?`),
        actions: [
          { label: "Start fresh", onClick: () => { answer = "fresh"; return true; } },
          { label: "Keep my values", kind: "primary", onClick: () => { answer = "keep"; return true; } },
        ],
        onClose: () => resolve(answer),
      });
    });
  }

  async function changeStrategy(select, previous) {
    const next = select.value;
    const typed = live().some((r) => r.hasInput());
    if (!typed) { applyTemplate(next); return next; }
    const choice = await askTemplateChange(next);
    if (choice === "cancel") { select.value = previous; return previous; }
    const old = live().map((r) => r.values());
    applyTemplate(next);
    if (choice === "keep") rows.forEach((r, i) => { if (old[i]) r.setValues(old[i]); });
    updatePreview();
    return next;
  }

  function addLeg() {
    const r = LegRows.legRow({ side: "buy", kind: "call", qty: contracts(), expiry: $("#exp-front").value });
    r.onChange(updatePreview);
    rows.push(r);
    $("#legs tbody").append(r.tr);
    updatePreview();
  }

  function rescaleContracts(prev, next) {
    if (!(prev > 0) || prev === next) return;
    $("#legs tbody").querySelectorAll("tr").forEach((tr) => {
      const q = tr.querySelector('input[type="number"]');
      const v = Number(q.value);
      if (v > 0) q.value = String(Math.round((v / prev) * next * 1e6) / 1e6);
    });
    updatePreview();
  }

  function updatePreview() {
    if (later) later.refresh(live().map((r) => r.draft()));
    const legs = live().map((r) => r.peek());
    const ready = legs.length > 0 && legs.every(Boolean);
    const spot = journal ? numVal(journal.input("underlying_entry")) : null;
    if (!ready) {
      clear($("#preview-stats"), stat("Net premium", "—"), stat("Max profit", "—"), stat("Max loss", "—"), stat("Breakevens", "—"));
      Charts.empty($("#preview"), "Fill in every leg's strike and price to see the payoff.");
      return;
    }
    const pLegs = legs.map((l) => ({ ...l, multiplier: l.kind === "stock" ? 1 : 100 }));
    const s = Payoff.summarise(pLegs, spot > 0 ? spot : null);
    clear($("#preview-stats"),
      stat(s.netPremium >= 0 ? "Net credit" : "Net debit", Fmt.plainMoney(Math.abs(s.netPremium)), s.netPremium >= 0 ? "pos" : "neg"),
      stat("Max profit", s.maxProfit === null ? "Unlimited" : Fmt.plainMoney(s.maxProfit), "pos"),
      stat("Max loss", s.maxLoss === null ? "Unlimited" : Fmt.plainMoney(-s.maxLoss), "neg"),
      stat("Breakevens", s.breakevens.length ? s.breakevens.map((b) => Fmt.num(b)).join(" / ") : "—"),
      realisedStat());
    const c = Payoff.curve(pLegs, spot > 0 ? spot : null);
    drawPayoff($("#preview"), c.prices, c.pnl, spot > 0 ? spot : null);
  }

  /** Realised P&L of the later closes typed below, when there are any and all are priced. */
  function realisedStat() {
    const r = later ? later.realised() : null;
    return r === null ? null : stat("Realised (later fills)", Fmt.money(r), Fmt.signClass(r), "before commissions");
  }

  function drawPayoff(node, x, y, spot) {
    const { C } = Charts;
    const pos = y.map((v) => Math.max(v, 0));
    const neg = y.map((v) => Math.min(v, 0));
    const traces = [
      { x, y: pos, type: "scatter", mode: "lines", line: { width: 0 }, fill: "tozeroy", fillcolor: C.posFill, hoverinfo: "skip" },
      { x, y: neg, type: "scatter", mode: "lines", line: { width: 0 }, fill: "tozeroy", fillcolor: C.negFill, hoverinfo: "skip" },
      { x, y, type: "scatter", mode: "lines", line: { color: C.blue, width: 2 }, name: "At expiry",
        hovertemplate: "$%{x:.2f}<br>%{y:$,.2f}<extra></extra>" },
    ];
    const shapes = spot ? [{ type: "line", x0: spot, x1: spot, yref: "paper", y0: 0, y1: 1, line: { color: C.accent, width: 1, dash: "dot" } }] : [];
    Charts.render(node, traces, { hovermode: "x", shapes, yaxis: { tickformat: "$,.0f", zeroline: true }, xaxis: { tickprefix: "$" } });
  }

  function buildPayload() {
    const underlying = $("#underlying").value.trim().toUpperCase();
    $("#underlying").classList.remove("bad");
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(underlying)) {
      $("#underlying").classList.add("bad");
      $("#underlying").focus();
      throw new Error("Enter the underlying symbol (letters, e.g. SPY).");
    }
    const opened = $("#opened").value;
    if (!opened) throw new Error("Pick the date the trade was opened.");
    const legs = live();
    if (!legs.length) throw new Error("Add at least one leg.");
    const fills = legs.map((r) => LegRows.toFill(r.read()));
    later.refresh(legs.map((r) => r.draft())); // the later blocks must match the opening rows being saved
    const events = later.read(opened);
    const account = Number($("#account").value);
    const account_id = Number.isInteger(account) && account > 0 ? account : undefined; // left out: the server's default
    return { underlying, strategy: $("#strategy").value, opened_at: opened, account_id, fills, events, ...journal.read() };
  }

  async function save() {
    if (saving) return;
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      toast(err.message, "err");
      return;
    }
    saving = true;
    $("#save").disabled = true;
    try {
      const view = await Api.post("/api/journal/trades", payload);
      location.href = `/journal/trade?id=${encodeURIComponent(view.id)}`;
    } catch (_) {
      // Api already showed the server's message; let the user fix and retry.
      saving = false;
      $("#save").disabled = false;
    }
  }

  /** Fill the form from a strategy built in the analyser ("Log as trade"). */
  function applyPrefill(p, meta) {
    const select = $("#strategy");
    select.value = Prefill.chooseStrategy(p, meta.strategies, Strategies.guessStrategy);
    $("#underlying").value = p.underlying;
    if (p.opened_at) $("#opened").value = p.opened_at;
    $("#contracts").value = "1";
    const expiries = p.legs.map((l) => l.expiry).filter(Boolean).sort();
    $("#exp-front").value = expiries[0] || "";
    $("#exp-back").value = expiries[expiries.length - 1] || "";
    $("#exp-back-wrap").classList.toggle("hidden", !Strategies.usesTwoExpiries(select.value));
    rows = p.legs.map((l) => {
      const r = LegRows.legRow({ side: l.side, kind: l.kind, qty: l.qty, expiry: l.expiry || "",
        group: l.expiry && l.expiry !== expiries[0] ? "back" : "front" });
      r.setValues({ kind: l.kind, strike: l.strike === null ? "" : String(l.strike), expiry: l.expiry || "",
        price: l.price === null ? "" : String(l.price), commission: "" });
      r.onChange(updatePreview);
      return r;
    });
    clear($("#legs tbody"), rows.map((r) => r.tr));
    if (p.underlying_entry) journal.input("underlying_entry").value = String(p.underlying_entry);
    if (p.iv_entry) journal.input("iv_entry").value = String(p.iv_entry);
    updatePreview();
    const from = p.account_id ? "Portfolio" : "the analyser"; // only Portfolio's hand-off names an account
    toast(`Loaded ${p.legs.length} leg${p.legs.length === 1 ? "" : "s"} from ${from}. Check the fill prices and date, then save.`, "ok", 7000);
  }

  /** The analyser's strategy, when this page was opened with ?from=analyser
   *  (?from=analyzer, the old spelling, still works). */
  function readPrefill() {
    if (!["analyser", "analyzer"].includes(new URLSearchParams(location.search).get("from"))) return null;
    try {
      return Prefill.take(sessionStorage);
    } catch (err) {
      toast(err.message, "err");
      return null;
    }
  }

  /** The Account select: every account, defaulting to the first IBKR account, or to the only
   *  account the shared filter selects. Follows the filter until the user picks one here.
   *  `preferred` (a prefill's account, e.g. Portfolio's Log as trade) counts as a pick. */
  async function wireAccounts(preferred) {
    const select = $("#account");
    let touched = false;
    let first = Number.isInteger(preferred) ? preferred : null;
    select.addEventListener("change", () => { touched = true; });
    const fill = async () => {
      const accounts = await ODAccounts.load();
      const keep = touched ? Number(select.value) : first;
      first = null;
      if (keep !== null) touched = true;
      clear(select, accounts.map((a) => el("option", { value: a.id }, AccountPick.optionLabel(a))));
      const want = keep && accounts.some((a) => a.id === keep) ? keep
        : AccountPick.defaultAccountId(accounts, ODAccounts.selected(accounts));
      if (want !== null) select.value = String(want);
    };
    window.addEventListener(ODAccounts.EVENT, () => { fill().catch(() => {}); });
    try {
      await fill();
    } catch (err) {
      // Without the list the server still files the trade under its default account.
      clear(select, el("option", { value: "" }, "Default account"));
      toast(`Accounts are unavailable (${err.message || err}); the trade goes to the default account.`, "err");
    }
  }

  boot(async () => {
    $("#opened").value = Fmt.todayIso();
    const prefill = readPrefill(); // read first: it may name the account to file the trade under
    wireAccounts(prefill ? prefill.account_id : null);
    const meta = await Api.get("/api/journal/meta");
    const select = $("#strategy");
    meta.strategies.forEach((id) => select.append(el("option", { value: id }, Fmt.strategyLabel(id))));
    select.value = "bull_put_spread";
    $("#legs thead").append(LegRows.headRow());
    later = LaterUI.mount($("#later"), { onChange: updatePreview });
    journal = Journal.journalForm({}, meta, { review: false });
    $("#journal").append(journal.el);
    journal.input("underlying_entry").addEventListener("input", updatePreview);

    let currentStrategy = select.value;
    select.addEventListener("change", async () => { currentStrategy = await changeStrategy(select, currentStrategy); });
    $("#add-leg").addEventListener("click", addLeg);
    let prevContracts = contracts();
    $("#contracts").addEventListener("change", () => { const n = contracts(); rescaleContracts(prevContracts, n); prevContracts = n; });
    const setGroupExpiry = (group, iso) => {
      live().filter((r) => r.group === group).forEach((r) => r.setExpiry(iso));
      updatePreview(); // setExpiry fires no change event; keep the later blocks' contracts current
    };
    $("#exp-front").addEventListener("input", () => setGroupExpiry("front", $("#exp-front").value));
    $("#exp-back").addEventListener("input", () => setGroupExpiry("back", $("#exp-back").value));
    $("#underlying").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });
    $("#save").addEventListener("click", save);
    if (prefill) {
      applyPrefill(prefill, meta);
      currentStrategy = select.value;
    } else {
      applyTemplate(select.value);
    }
    $("#underlying").focus();
  });
})();
