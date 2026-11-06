/* IBKR fill import (the panel on the Trades page, #ibkr-import): the platform's shared TWS connection (/api/broker on the gateway) and the
 * fill review queue. Never polls: status is read on load, after our own actions, when the
 * tab comes back into view, and it follows the nav chip's "broker:status" and other
 * modules' "broker:changed" / "broker:busy" events. Listeners never re-dispatch. */
(function () {
  "use strict";
  const { el, clear, $, toast } = UI;
  const FOCUS_SETTLE_MS = 400; // give the nav chip's own focus read a moment to arrive first

  let view = Broker.statusView(null);
  let lastSync = null;
  let showing = "pending";
  let openTrades = [];
  let accounts = [];      // for "Goes to <account>" on each pending group
  let busy = false;
  let othersBusy = new Set();
  let statusAt = 0;

  const EVENTS = [["close", "Close"], ["adjust", "Adjust"], ["roll", "Roll"], ["expire", "Expire"], ["assign", "Assignment"], ["open", "Open (add)"]];

  function renderStatus() {
    $("#dot").classList.toggle("on", view.connected);
    $("#message").textContent = view.message;
    $("#message").className = `mono ${view.connected ? "pos" : "muted"}`;
    clear($("#details"),
      el("dt", {}, "Connection"), el("dd", {}, "shared by the whole app (read-only)"),
      el("dt", {}, "Last sync"), el("dd", { class: "num" }, lastSync ? Fmt.dateTime(lastSync) : "never (this session)"));
    const locked = busy || othersBusy.size > 0;
    $("#connect").disabled = locked || view.connected;
    $("#disconnect").disabled = locked || !view.connected;
    $("#sync").disabled = busy || !view.connected;
  }

  function showStatus(body) {
    view = Broker.statusView(body);
    statusAt = Date.now();
    renderStatus();
  }

  async function refreshStatus() {
    try {
      showStatus(await Broker.status());
    } catch (err) {
      view = { connected: false, known: false, message: err.message };
      statusAt = Date.now();
      renderStatus();
    }
  }

  /** Runs one action. Connect/disconnect (`broker: true`) tell other components we're busy,
   *  and afterwards — success or failure — re-read the real state and announce it. */
  async function act(fn, { broker = false } = {}) {
    if (busy || (broker && othersBusy.size)) return;
    busy = true;
    renderStatus();
    if (broker) Broker.setBusy(true);
    try {
      await fn();
    } catch (err) {
      // Api errors were already toasted; broker errors are ours to show.
      if (err instanceof Broker.BrokerError) toast(err.message, "err");
    } finally {
      if (broker) Broker.setBusy(false);
      busy = false;
      if (broker) {
        await refreshStatus(); // a timed-out disconnect may still have gone through
        Broker.announce();
      }
      renderStatus();
    }
  }

  const connect = () => act(async () => {
    $("#message").textContent = "Connecting to TWS…";
    const reply = await Broker.connect();
    const failed = Broker.connectFailure(reply);
    toast(failed || "Connected to TWS.", failed ? "err" : "ok");
  }, { broker: true });
  const disconnect = () => act(async () => {
    await Broker.disconnect();
  }, { broker: true });
  const sync = () => act(async () => {
    $("#message").textContent = "Fetching executions…";
    try {
      const r = await Api.post("/api/journal/ibkr/sync");
      lastSync = r.last_sync;
      toast(Fills.syncSummary(r), "ok");
      await loadQueue();
    } catch (err) {
      if (Broker.isNotConnected(err)) Broker.announce(); // TWS dropped: let the chip know
      throw err;
    } finally {
      await refreshStatus(); // a sync can reveal that TWS dropped
    }
  });

  // ---------- queue --------------------------------------------------------------------
  function fillRow(f) {
    return el("tr", {},
      el("td", { class: "num muted" }, Fmt.dateTime(f.executed_at)),
      el("td", {}, el("span", { class: `side ${f.qty > 0 ? "long" : "short"}`, style: { display: "inline-block", textAlign: "center", lineHeight: "26px" } }, f.qty > 0 ? "BUY" : "SELL")),
      el("td", { class: "r num" }, String(Math.abs(f.qty))),
      el("td", {}, f.kind),
      el("td", { class: "r num" }, f.strike !== null ? Fmt.strike(f.strike) : "—"),
      el("td", { class: "num" }, f.expiry ? Fmt.date(f.expiry) : "—"),
      el("td", { class: "r num" }, Fmt.num(f.price, 2)),
      Fills.pendingCommissions([f]).length
        ? el("td", { class: "r warn-note", title: "TWS has not reported this commission yet; the next sync fills it in, even after you assign the fill." }, "pending")
        : el("td", { class: "r num faint" }, Fmt.plainMoney(f.commission)));
  }

  function newTradeControls(group, ids) {
    const guess = Strategies.guessStrategy(group.fills.map((f) => ({ kind: f.kind, strike: f.strike, expiry: f.expiry, qty: f.qty })));
    const strat = el("select", {}, Object.keys(Fmt.STRATEGY_LABELS).map((id) =>
      el("option", { value: id, selected: id === guess }, Fmt.strategyLabel(id))));
    const btn = el("button", { type: "button", class: "btn primary sm" }, "Create trade");
    btn.addEventListener("click", () => assign({ exec_ids: ids, strategy: strat.value, event: "open" }, btn, group.fills));
    // Display only: the importer picks the account (broker ref match, else the default IBKR account).
    const where = AccountPick.fillDestination(accounts, group.fills);
    return [el("span", { class: "lbl" }, "New trade as"), strat, btn,
      where ? el("span", { class: "note fill-account", title: "Set an IBKR account's broker ref in Settings → Accounts" }, where) : null];
  }

  function existingControls(group, ids) {
    const candidates = openTrades.filter((t) => t.underlying === group.symbol);
    if (!candidates.length) return [el("span", { class: "note" }, `No open ${group.symbol} trades to add to.`)];
    const trade = el("select", {}, candidates.map((t) =>
      el("option", { value: t.id }, `#${t.id} ${Fmt.strategyLabel(t.strategy)} · ${Fmt.date(t.opened_at)}`)));
    const event = el("select", { title: "What these fills do to the trade" },
      EVENTS.map(([v, label]) => el("option", { value: v }, label)));
    // Default: "close" when the fills only reduce that trade's open legs, else "adjust".
    const suggest = () => {
      const t = candidates.find((c) => c.id === Number(trade.value));
      event.value = Fills.suggestEvent(group.fills, t);
    };
    trade.addEventListener("change", suggest);
    suggest();
    const btn = el("button", { type: "button", class: "btn sm" }, "Add to trade");
    btn.addEventListener("click", () => {
      if (!event.value) { toast("Pick what these fills do to the trade (close, adjust, roll…).", "err"); return; }
      assign({ exec_ids: ids, trade_id: Number(trade.value), event: event.value }, btn, group.fills);
    });
    return [el("span", { class: "lbl" }, "or add to"), trade, el("span", { class: "lbl" }, "as"), event, btn];
  }

  function groupCard(group) {
    const ids = group.fills.map((f) => f.exec_id);
    const footer = showing === "pending"
      ? [...newTradeControls(group, ids), el("span", { class: "grow" }), ...existingControls(group, ids),
        el("button", { type: "button", class: "btn sm", onclick: (e) => ignore(ids, false, e.currentTarget) }, "Ignore")]
      : [el("span", { class: "grow" }), el("button", { type: "button", class: "btn sm", onclick: (e) => ignore(ids, true, e.currentTarget) }, "Restore")];
    return el("div", { class: "group" },
      el("div", { class: "group-h" }, el("b", {}, group.symbol), el("span", { class: "muted num" }, Fmt.dateTime(group.executed_at)),
        el("span", { class: "faint" }, `${group.fills.length} fill${group.fills.length === 1 ? "" : "s"}`),
        Fills.pendingCommissions(group.fills).length ? el("span", { class: "warn-note" }, "commission pending") : null,
        el("span", { class: "grow" }),
        el("span", { class: `num ${Fmt.signClass(group.net_cash)}` }, `net ${Fmt.money(group.net_cash)}`)),
      el("div", { class: "table-wrap" }, el("table", { class: "t" },
        el("thead", {}, el("tr", {}, ["Time", "Side", "Qty", "Type", "Strike", "Expiry", "Price", "Comm."].map((h, i) =>
          el("th", { class: [2, 4, 6, 7].includes(i) ? "r" : "" }, h)))),
        el("tbody", {}, group.fills.map(fillRow)))),
      el("div", { class: "group-f" }, footer));
  }

  async function assign(body, btn, fills) {
    btn.disabled = true;
    try {
      const r = await Api.post("/api/journal/ibkr/assign", body);
      toast(UI.el("span", {}, "Saved to ", el("a", { href: `/journal/trade?id=${r.trade_id}` }, `trade #${r.trade_id}`), "."), "ok", 6000);
      // The Trades page shows this import panel above its list: let the list reload.
      window.dispatchEvent(new CustomEvent("journal:trades-changed", { detail: { trade_id: r.trade_id } }));
      const pending = Fills.pendingCommissions(fills).length;
      if (pending) {
        toast(`${pending} commission${pending === 1 ? " was" : "s were"} not reported yet; sync again later and they are filled in on the trade.`, "err", 8000);
      }
      await loadQueue();
    } catch (_) {
      btn.disabled = false;
    }
  }

  async function ignore(ids, restore, btn) {
    btn.disabled = true;
    try {
      await Api.post("/api/journal/ibkr/ignore", { exec_ids: ids, restore });
      await loadQueue();
    } catch (_) {
      btn.disabled = false;
    }
  }

  async function loadQueue() {
    const [groups, trades, list] = await Promise.all([
      Api.get(`/api/journal/ibkr/pending?status=${showing}`),
      Api.get("/api/journal/trades"),
      ODAccounts.load().catch(() => []),
    ]);
    accounts = list;
    openTrades = trades.filter((t) => t.status === "open");
    $("#queue-title").textContent = showing === "pending" ? "Fills waiting for a trade" : "Ignored fills";
    clear($("#queue"), groups.length ? groups.map(groupCard)
      : el("div", { class: "empty" }, showing === "pending"
        ? "Nothing waiting. Connect to TWS and press Sync fills to pull today's executions."
        : "No ignored fills."));
  }

  boot(async () => {
    $("#connect").addEventListener("click", connect);
    $("#disconnect").addEventListener("click", disconnect);
    $("#sync").addEventListener("click", sync);
    document.querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => {
      showing = b.dataset.status;
      document.querySelectorAll("[data-status]").forEach((x) => x.classList.toggle("on", x === b));
      loadQueue().catch(() => {});
    }));
    // Other modules announce a change: re-read (our own act() re-reads itself when it ends).
    window.addEventListener(Broker.EVENT, (e) => {
      const own = e.detail && e.detail.source === Broker.SOURCE;
      if (!own && !busy) refreshStatus();
    });
    // The nav chip shares every status it reads; follow it without fetching.
    window.addEventListener(Broker.STATUS_EVENT, (e) => {
      if (!busy && e.detail && e.detail.status) showStatus(e.detail.status);
    });
    window.addEventListener(Broker.BUSY_EVENT, (e) => {
      othersBusy = Broker.othersBusy(othersBusy, e.detail);
      renderStatus();
    });
    // Back to this tab: the chip re-reads on focus; only fetch if its answer didn't arrive.
    const onReturn = () => setTimeout(() => {
      if (!busy && Date.now() - statusAt > FOCUS_SETTLE_MS) refreshStatus();
    }, FOCUS_SETTLE_MS);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") onReturn(); });
    const info = await Api.get("/api/journal/ibkr/info", { quiet: true }).catch(() => null);
    lastSync = info && info.last_sync;
    await refreshStatus(); // renders even on failure, so the buttons are never left stuck
    await loadQueue();
  });
})();
