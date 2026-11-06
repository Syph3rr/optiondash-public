/* Trade list page. The list follows the shared account filter (ODAccounts, the picker in the
 * page header): it loads /api/journal/trades?accounts=… and reloads on 'od:accounts'. Rows have
 * checkboxes for the bulk move bar (bulkmove.js). */
(function () {
  "use strict";
  const { el, clear, $, stat } = UI;
  const STORE_KEY = "tradelog.list";

  const COLS = 14;
  let trades = [];
  let accounts = [];
  let selected = new Set();
  let sort = { key: "opened_at", dir: "desc" };

  /** The trades in the selected accounts, and the account list (for names and the move bar). */
  let loadSeq = 0;
  async function loadTrades() {
    const mine = ++loadSeq;
    const list = await ODAccounts.load().catch(() => []);
    const q = ODAccounts.query(list);
    const rows = await Api.get(`/api/journal/trades${q ? `?${q}` : ""}`);
    if (mine !== loadSeq) return false; // a newer filter change already loaded
    accounts = list;
    trades = rows;
    return true;
  }

  async function reload() {
    if (!(await loadTrades())) return;
    renderHeadline();
    renderTable();
  }

  function saved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; }
  }
  function remember(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* private mode: fine */ }
  }

  const inputs = () => ({
    status: $("#f-status"), underlying: $("#f-underlying"), strategy: $("#f-strategy"),
    from: $("#f-from"), to: $("#f-to"), tag: $("#f-tag"),
  });

  function readFilters() {
    return Object.fromEntries(Object.entries(inputs()).map(([k, node]) => [k, node.value]));
  }

  function renderHeadline() {
    const h = Filters.headline(trades);
    clear($("#headline"),
      stat("Open trades", String(h.open)),
      stat("Closed trades", String(h.closed)),
      stat("Realised P&L", Fmt.money(h.realized), Fmt.signClass(h.realized)),
      stat("Win rate", h.winRate === null ? "—" : Fmt.pct(h.winRate)));
  }

  function tagChips(tags) {
    return el("span", { class: "chips" }, (tags || []).slice(0, 4).map((t) =>
      el("span", { class: `chip ${t.kind === "tag" ? "" : t.kind}` }, t.value)),
    (tags || []).length > 4 ? el("span", { class: "faint" }, `+${tags.length - 4}`) : null);
  }

  function row(t) {
    const pnl = Filters.pnlOf(t);
    const pnlCell = el("td", { class: `r num ${Fmt.signClass(pnl)}`,
      title: t.status === "open" ? (pnl === null ? "Add a mark to see unrealised P&L" : "Unrealised, from latest mark") : "Realised" },
      Fmt.money(pnl), t.status === "open" && pnl !== null ? el("span", { class: "faint" }, " u") : null);
    const box = el("input", { type: "checkbox", checked: selected.has(t.id), "aria-label": `Select trade #${t.id}`,
      onchange: () => toggle(t.id, box.checked) });
    return el("tr", { class: `click${selected.has(t.id) ? " picked" : ""}`, tabindex: 0, onclick: () => go(t.id), onkeydown: (e) => { if (e.key === "Enter") go(t.id); } },
      el("td", { class: "pick", onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() }, box),
      el("td", { class: "num faint" }, String(t.id)),
      el("td", { class: "num" }, Fmt.date(t.opened_at)),
      el("td", {}, el("b", {}, t.underlying)),
      el("td", {}, Fmt.strategyLabel(t.strategy)),
      el("td", { class: "muted" }, t.account_name || ""),
      el("td", { class: "num muted", style: { fontSize: "12px" } }, t.status === "open" ? Fmt.legsSummary(t.legs, "net_qty") : legsFallback(t)),
      el("td", { class: "r num" }, t.dte_at_entry ?? "—"),
      el("td", { class: "r num" }, t.days_held ?? "—"),
      el("td", {}, el("span", { class: `chip ${t.status}` }, t.status)),
      pnlCell,
      el("td", { class: `r num ${Fmt.signClass(t.return_on_risk)}` }, Fmt.pct(t.return_on_risk, 1, true)),
      el("td", {}, el("span", { class: "stars" }, Fmt.stars(t.confidence))),
      el("td", {}, tagChips(t.tags)));
  }

  /** Closed trades have no net position: describe the legs as they were opened. */
  function legsFallback(t) {
    const opening = (t.legs || []).map((l) => ({
      ...l, opening_qty: (l.executions || []).filter((e) => e.event === "open").reduce((s, e) => s + e.qty, 0),
    }));
    return Fmt.legsSummary(opening, "opening_qty");
  }

  function go(id) { location.href = `/journal/trade?id=${encodeURIComponent(id)}`; }

  function toggle(id, on) {
    selected = new Set(selected);
    if (on) selected.add(id); else selected.delete(id);
    renderTable();
  }

  function clearSelection() {
    selected = new Set();
    renderTable();
  }

  function paintSelection(shownIds) {
    const all = $("#pick-all");
    const state = AccountPick.selectAllState(selected, shownIds);
    all.checked = state === "all";
    all.indeterminate = state === "some";
    all.disabled = !shownIds.length;
    BulkMove.render($("#bulk"), { selected, accounts, trades, onDone: reload, onClear: clearSelection });
  }

  function renderTable() {
    const filters = readFilters();
    remember({ filters, sort });
    const shown = Filters.sortTrades(Filters.filterTrades(trades, filters), sort.key, sort.dir);
    // Only visible rows can stay selected, so a move never touches a trade you cannot see.
    selected = AccountPick.pruneSelection(selected, shown.map((t) => t.id));
    const body = $("#trades tbody");
    if (!trades.length && ODAccounts.query(accounts)) {
      clear(body, el("tr", {}, el("td", { colspan: COLS, class: "empty" }, "No trades in the selected accounts.")));
    } else if (!trades.length) {
      clear(body, el("tr", {}, el("td", { colspan: COLS, class: "empty" },
        "No trades yet. ", el("a", { href: "/journal/?new=1" }, "Log your first trade"), " or import fills from ", el("a", { href: "/journal/?import=1" }, "IBKR"), ".")));
    } else if (!shown.length) {
      clear(body, el("tr", {}, el("td", { colspan: COLS, class: "empty" }, "No trades match these filters.")));
    } else {
      clear(body, shown.map(row));
    }
    $("#count").textContent = `${shown.length} of ${trades.length}`;
    paintSelection(shown.map((t) => t.id));
    document.querySelectorAll("#trades th.sort").forEach((th) => {
      const on = th.dataset.key === sort.key;
      th.classList.toggle("on", on);
      th.textContent = th.textContent.replace(/ [▲▼]$/, "") + (on ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
    });
  }

  function wire() {
    Object.values(inputs()).forEach((node) => node.addEventListener("input", renderTable));
    $("#f-reset").addEventListener("click", () => {
      Object.entries(inputs()).forEach(([k, node]) => { node.value = Filters.EMPTY[k]; });
      renderTable();
    });
    $("#pick-all").addEventListener("change", (e) => {
      selected = e.target.checked ? new Set(Filters.filterTrades(trades, readFilters()).map((t) => t.id)) : new Set();
      renderTable();
    });
    document.querySelectorAll("#trades th.sort").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.key;
      sort = { key, dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc" };
      renderTable();
    }));
  }

  boot(async () => {
    ODAccounts.picker($("#account-picker")).catch(() => {});
    const [meta] = await Promise.all([Api.get("/api/journal/meta"), loadTrades()]);
    const select = $("#f-strategy");
    meta.strategies.forEach((id) => select.append(el("option", { value: id }, Fmt.strategyLabel(id))));
    const state = saved();
    if (state.filters) Object.entries(inputs()).forEach(([k, node]) => { if (state.filters[k] !== undefined) node.value = state.filters[k]; });
    if (state.sort && state.sort.key) sort = state.sort;
    wire();
    renderHeadline();
    renderTable();
    // The IBKR import panel on this page can add trades: reload the list when it does.
    window.addEventListener("journal:trades-changed", () => reload().catch(() => {}));
    // The account filter changed (here, on another page or in another tab).
    window.addEventListener(ODAccounts.EVENT, () => reload().catch(() => {}));
  });
})();
