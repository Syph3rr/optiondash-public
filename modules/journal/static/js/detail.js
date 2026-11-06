/* Trade detail page. */
(function () {
  "use strict";
  const { el, clear, $, stat, numVal, toast, confirmModal } = UI;

  const id = Number(new URLSearchParams(location.search).get("id"));
  let view = null;
  let journal = null;
  let accounts = [];      // GET /api/journal/accounts, for the Account select in the title bar
  let busy = false;       // an action is in flight; action buttons stay disabled until reload

  const ACTION_BUTTONS = ["#act-adjust", "#act-expire", "#act-mark", "#delete"];

  /** Enable action buttons from the current view (or disable them all while busy). */
  function paintActions() {
    const hasOpen = !!view && TradeActions.openLegs(view).length > 0;
    $("#act-adjust").disabled = busy;
    $("#act-expire").disabled = busy || !hasOpen;
    $("#act-mark").disabled = busy || !hasOpen;
    $("#delete").disabled = busy;
  }

  /** Run an action with every action button disabled until it (and its reload) finishes. */
  async function guarded(fn) {
    if (busy) return;
    busy = true;
    paintActions();
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof Api.ApiError)) toast(err.message || String(err), "err");
    } finally {
      busy = false;
      paintActions();
    }
  }

  /** Api errors were already toasted; anything else is a bug worth showing. */
  const shown = (promise) => promise.catch((err) => {
    if (!(err instanceof Api.ApiError)) toast(err.message || String(err), "err");
  });
  const reload = () => load({ keepJournal: true });

  // ---------- header & stats -----------------------------------------------------------
  function renderHeader() {
    document.title = `${view.underlying} ${Fmt.strategyLabel(view.strategy)} · Journal · OptionDash`;
    clear($("#title-bar"),
      el("h1", {}, `#${view.id} ${view.underlying} · ${Fmt.strategyLabel(view.strategy)}`),
      el("span", { class: `chip ${view.status}` }, view.status),
      el("span", { class: "muted num" },
        `Opened ${Fmt.date(view.opened_at)}`, view.closed_at ? ` · closed ${Fmt.date(view.closed_at)}` : "",
        ` · ${view.days_held ?? "—"} days held`, view.dte_at_entry !== null ? ` · ${view.dte_at_entry} DTE at entry` : ""),
      el("span", { class: "grow" }),
      el("span", { class: "stars", title: "Confidence" }, Fmt.stars(view.confidence)),
      accountControl(),
      el("span", { class: "chip" }, view.source === "ibkr" ? "IBKR" : "manual"),
      el("a", { class: "btn sm", href: `/?journal_trade=${encodeURIComponent(view.id)}`,
        title: "Load this position into the options analyser", style: { display: "inline-flex", alignItems: "center", color: "var(--text)" } },
        "Open in Options Analyser"));
    $("#meta-line").textContent = `Created ${Fmt.dateTime(view.created_at)} · updated ${Fmt.dateTime(view.updated_at)}`;
  }

  /** The trade's account, changeable in place (PATCH account_id). Just the name if the list is unavailable. */
  function accountControl() {
    if (!accounts.length) return el("span", { class: "title-account" }, "Account", el("b", {}, view.account_name || "—"));
    const list = accounts.some((a) => a.id === view.account_id) ? accounts
      : [...accounts, { id: view.account_id, name: view.account_name, type: "" }];
    const select = el("select", { class: "inp", id: "trade-account", "aria-label": "Account" },
      list.map((a) => el("option", { value: a.id, selected: a.id === view.account_id }, a.type ? AccountPick.optionLabel(a) : a.name)));
    select.addEventListener("change", () => guarded(async () => {
      const target = Number(select.value);
      select.disabled = true;
      try {
        await Api.patch(`/api/journal/trades/${id}`, { account_id: target });
        toast(`Moved to ${(accounts.find((a) => a.id === target) || {}).name || "that account"}.`, "ok");
      } catch (err) {
        select.value = String(view.account_id); // Api showed why
        throw err;
      } finally {
        select.disabled = false;
      }
      await reload();
    }));
    return el("label", { class: "title-account", for: "trade-account" }, "Account", select);
  }

  function renderStats() {
    const s = view.initial || {};
    const pnlLabel = view.status === "closed" ? "Realised P&L" : "Unrealised P&L";
    const pnlSub = view.status !== "open" ? ""
      : view.mark_stale ? "mark is older than the last fill"
        : view.pnl === null ? "add a mark" : "from latest mark";
    clear($("#stats"),
      stat(pnlLabel, Fmt.money(view.pnl), Fmt.signClass(view.pnl), pnlSub),
      stat("Return on risk", Fmt.pct(view.return_on_risk, 1, true), Fmt.signClass(view.return_on_risk)),
      stat("% of max profit", Fmt.pct(view.pct_of_max_profit, 0, true)),
      stat("Max profit", s.max_profit === null && view.initial ? "Unlimited" : Fmt.plainMoney(s.max_profit), "pos", "as opened"),
      stat("Max loss", view.max_risk ? Fmt.plainMoney(-view.max_risk) : s.max_loss === null && view.initial ? "Unlimited" : "—", "neg",
        view.max_risk_override ? "override" : "as opened"),
      stat("Breakevens", s.breakevens && s.breakevens.length ? s.breakevens.map((b) => Fmt.num(b)).join(" / ") : "—", "", "at first expiry"),
      stat(s.net_premium >= 0 ? "Net credit" : "Net debit", Fmt.plainMoney(Math.abs(s.net_premium ?? NaN)), s.net_premium >= 0 ? "pos" : "neg"),
      stat("Commissions", Fmt.plainMoney(view.commissions)));
  }

  // ---------- legs & fills -------------------------------------------------------------
  function renderLegs() {
    const head = el("thead", {}, el("tr", {}, ["Leg", "Net qty", "Avg cost", "Realised", "Mult."].map((h, i) =>
      el("th", { class: i ? "r" : "" }, h)), el("th", {}, "")));
    const body = el("tbody");
    for (const l of view.legs) {
      body.append(el("tr", {},
        el("td", { class: "num" }, el("b", {}, TradeActions.legName(l))),
        el("td", { class: "r num" }, Fmt.signedQty(l.net_qty)),
        el("td", { class: "r num" }, l.net_qty ? Fmt.num(l.avg_cost) : "—"),
        el("td", { class: `r num ${Fmt.signClass(l.realized)}` }, Fmt.money(l.realized)),
        el("td", { class: "r num faint" }, String(l.multiplier)),
        el("td", {})));
      for (const e of l.executions) {
        body.append(el("tr", { class: "sub" },
          el("td", {}, el("span", { class: "chip ev" }, e.event), " ", el("span", { class: "num muted" }, Fmt.dateTime(e.executed_at)),
            e.ibkr_exec_id ? el("span", { class: "faint", title: e.ibkr_exec_id }, " · IBKR") : null),
          el("td", { class: "r num" }, Fmt.signedQty(e.qty)),
          el("td", { class: "r num" }, `@ ${Fmt.num(e.price)}`),
          el("td", { class: "r num faint" }, e.commission ? `comm ${Fmt.plainMoney(e.commission)}` : ""),
          el("td", {}),
          el("td", { class: "r", style: { whiteSpace: "nowrap" } },
            el("button", { type: "button", class: "iconbtn", title: "Edit fill",
              onclick: () => TradeActions.editExecution(e, reload) }, "✎"), " ",
            el("button", { type: "button", class: "iconbtn del", title: "Delete fill",
              onclick: () => shown(TradeActions.deleteExecution(e, reload)) }, "✕"))));
      }
    }
    if (!view.legs.length) body.append(el("tr", {}, el("td", { colspan: 6, class: "empty" }, "No legs.")));
    clear($("#legs"), head, body);
    paintActions();
  }

  function renderMarks() {
    const marks = view.marks || [];
    if (!marks.length) {
      clear($("#marks"), el("span", { class: "note" }, view.status === "open"
        ? "No marks yet. Add a mark to track unrealised P&L over time." : ""));
      return;
    }
    clear($("#marks"), el("div", { class: "lbl", style: { marginBottom: "6px" } }, "Marks"),
      view.mark_stale ? el("div", { class: "warn-note", style: { marginBottom: "6px" } },
        "The latest mark is older than the last fill, so unrealised P&L is not shown. Add a new mark.") : null,
      el("table", { class: "t" }, el("tbody", {}, marks.map((m) => el("tr", {},
        el("td", { class: "num" }, Fmt.date(m.marked_at)),
        el("td", { class: "r num" }, `value ${Fmt.money(m.position_value)}`),
        el("td", { class: "r num muted" }, m.underlying_price ? `spot ${Fmt.num(m.underlying_price)}` : ""),
        el("td", { class: "r" }, el("button", { type: "button", class: "iconbtn del", title: "Delete mark",
          onclick: () => shown(TradeActions.deleteMark(m, reload)) }, "✕")))))));
  }

  // ---------- charts -------------------------------------------------------------------
  // Pricing, controls and the Greeks strip live in tradepricing.js (gateway engine).
  function wireCharts() {
    TradePricing.mount({ controls: $("#engine-controls"), greeks: $("#greeks"), chart: $("#chart"), note: $("#chart-note") });
    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
      shown(TradePricing.setTab(b.dataset.tab));
    }));
  }

  // ---------- journal ------------------------------------------------------------------
  function renderJournal(meta) {
    journal = Journal.journalForm(view, meta, { review: true });
    journal.onChange(() => $("#dirty").classList.remove("hidden"));
    clear($("#journal"), journal.el);
    $("#dirty").classList.add("hidden");
  }

  async function saveJournal() {
    let body;
    try { body = journal.read(); } catch (err) { toast(err.message, "err"); return; }
    $("#save-journal").disabled = true;
    try {
      await Api.patch(`/api/journal/trades/${id}`, body);
      toast("Journal saved.", "ok");
      await load();
    } catch (_) { /* Api showed the error; edits stay on screen */ } finally {
      $("#save-journal").disabled = false;
    }
  }

  // ---------- load ---------------------------------------------------------------------
  let metaCache = null;
  async function load({ keepJournal = false } = {}) {
    view = await Api.get(`/api/journal/trades/${id}`);
    renderHeader();
    renderStats();
    renderLegs();
    renderMarks();
    if (!keepJournal || !journal) renderJournal(metaCache);
    Shots.mount($("#shots"), view, reload);
    shown(TradePricing.update(view));
  }

  function wireActions() {
    $("#act-adjust").addEventListener("click", () => TradeActions.adjust(view, reload));
    $("#act-expire").addEventListener("click", () => guarded(() => TradeActions.expireWorthless(view, reload)));
    $("#act-mark").addEventListener("click", () => TradeActions.addMark(view, reload));
    $("#save-journal").addEventListener("click", saveJournal);
    $("#delete").addEventListener("click", () => guarded(async () => {
      const ok = await confirmModal(`Delete trade #${id} (${view.underlying}) with all its fills, marks and screenshots? This cannot be undone.`,
        { title: "Delete trade", confirmLabel: "Delete trade" });
      if (!ok) return;
      await Api.del(`/api/journal/trades/${id}`);
      location.href = "/journal/";
    }));
    window.addEventListener("beforeunload", (e) => {
      if (!$("#dirty").classList.contains("hidden")) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  boot(async () => {
    if (!Number.isInteger(id) || id <= 0) {
      clear($("main"), el("div", { class: "card empty" }, "No trade id in the address. ", el("a", { href: "/journal/" }, "Back to trades")));
      return;
    }
    [metaCache, accounts] = await Promise.all([Api.get("/api/journal/meta"), ODAccounts.load().catch(() => [])]);
    // Accounts renamed or added in Settings (another tab): rebuild the select.
    window.addEventListener(ODAccounts.EVENT, () => {
      ODAccounts.load().then((list) => { accounts = list; if (view) renderHeader(); }, () => {});
    });
    wireCharts();
    wireActions();
    try {
      await load();
    } catch (err) {
      if (err.status === 404) clear($("main"), el("div", { class: "card empty" }, `Trade #${id} was not found. `, el("a", { href: "/journal/" }, "Back to trades")));
      throw err;
    }
  });
})();
