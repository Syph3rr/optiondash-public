/* Trade page chart controller: valuation controls (position, IV, spot, date), the call to
   the gateway's pricing engine, the Greeks strip, and which chart is shown. */
(function (root) {
  "use strict";
  const { el, clear, numVal, stat } = UI;

  const ENGINE_URL = "/api/analyze";
  const VIEWS = ["pnl", "heat", "gprice", "gtime"];
  const state = { which: "current", picked: false, dayIndex: null, seq: 0, ctrl: null, cacheKey: null, res: null };
  let dom = null;
  let view = null;
  let tab = "pnl";
  let timer = null;

  // ---------- engine call -------------------------------------------------------------
  async function price(body) {
    const key = JSON.stringify(body);
    if (key === state.cacheKey && state.res) return state.res;
    if (state.ctrl) state.ctrl.abort();
    state.ctrl = new AbortController();
    let r;
    try {
      r = await fetch(ENGINE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: key, signal: state.ctrl.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error("Could not reach the pricing engine.");
    }
    if (r.status === 404 || r.status === 405) {
      throw new Error("The pricing engine isn't available here. Open the journal through OptionDash (cargo run) to see these charts.");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Pricing failed (${r.status}).`);
    state.cacheKey = key;
    state.res = j;
    return j;
  }

  // ---------- controls ----------------------------------------------------------------
  function days(legs) {
    const b = Engine.expiryBounds(legs);
    return Engine.dayList(view.opened_at, b ? Engine.nyDay(b.last) : view.opened_at);
  }

  function selectedIndex(list, legs) {
    if (state.dayIndex !== null) return Math.min(state.dayIndex, list.length - 1);
    const at = Engine.defaultAtMs(view, legs, Date.now());
    return at === Engine.refMs(view) ? 0 : Math.max(list.indexOf(Engine.nyDay(at)), 0);
  }

  function buildControls() {
    dom.which = el("div", { class: "tabs" }, [["current", "Current position"], ["initial", "As opened"]].map(([k, label]) =>
      el("button", { type: "button", class: `tab ${state.which === k ? "on" : ""}`, "data-which": k,
        onclick: () => { state.picked = true; setWhich(k); draw(); } }, label)));
    dom.iv = el("input", { class: "inp num", type: "number", step: "0.1", min: "0.1", style: { width: "76px" }, oninput: soon });
    dom.spot = el("input", { class: "inp num", type: "number", step: "any", min: "0", style: { width: "96px" }, oninput: soon });
    dom.date = el("input", { class: "inp", type: "date", style: { width: "140px" }, onchange: () => pickDay(dom.date.value) });
    dom.slider = el("input", { type: "range", min: "0", step: "1", style: { width: "220px" },
      oninput: () => { state.dayIndex = Number(dom.slider.value); soon(30); } });
    const nudge = (d) => el("button", { type: "button", class: "iconbtn", title: d < 0 ? "Previous day" : "Next day",
      onclick: () => { state.dayIndex = Math.max(Number(dom.slider.value) + d, 0); draw(); } }, d < 0 ? "◀" : "▶");
    const reset = el("button", { type: "button", class: "btn sm", onclick: () => {
      dom.iv.value = ""; dom.spot.value = ""; state.dayIndex = null; draw();
    } }, "Reset");
    dom.when = el("span", { class: "note num" });
    clear(dom.controls, dom.which,
      el("label", { class: "lbl" }, "IV %"), dom.iv,
      el("label", { class: "lbl" }, "Spot"), dom.spot,
      el("label", { class: "lbl" }, "Date"), nudge(-1), dom.slider, nudge(1), dom.date, reset, dom.when);
  }

  function setWhich(k) {
    state.which = k;
    dom.which.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.which === k));
  }

  function pickDay(day) {
    if (!day) return;
    const list = days(Engine.positionLegs(view, state.which));
    const i = list.indexOf(day);
    state.dayIndex = i >= 0 ? i : day < list[0] ? 0 : list.length - 1;
    draw();
  }

  function soon(ms = 300) {
    clearTimeout(timer);
    timer = setTimeout(draw, typeof ms === "number" ? ms : 300);
  }

  function syncControls(list, i) {
    dom.slider.max = String(Math.max(list.length - 1, 0));
    dom.slider.value = String(i);
    dom.date.min = list[0];
    dom.date.max = list[list.length - 1];
    if (document.activeElement !== dom.date) dom.date.value = list[i];
    dom.iv.placeholder = String(view.iv_entry || Engine.DEFAULT_IV_PCT);
    dom.spot.placeholder = view.underlying_entry ? String(view.underlying_entry) : "required";
  }

  function renderGreeks(res, tIndex) {
    const g = Engine.greeksAt(res, tIndex);
    const sgn = (v, d) => (v > 0 ? "+" : "") + Fmt.num(v, d);
    clear(dom.greeks,
      stat("Delta Δ", sgn(g.delta, 1), Fmt.signClass(g.delta), "share-equivalents"),
      stat("Gamma Γ", sgn(g.gamma, 3), Fmt.signClass(g.gamma), "Δ per $1"),
      stat("Theta Θ", Fmt.money(g.theta), Fmt.signClass(g.theta), "$ per day"),
      stat("Vega ν", Fmt.money(g.vega), Fmt.signClass(g.vega), "$ per vol pt"),
      stat("Max profit", res.summary.max_profit === null ? "Unlimited" : Fmt.money(res.summary.max_profit), "pos", "engine, first expiry"),
      stat("Max loss", res.summary.max_loss === null ? "Unlimited" : Fmt.money(res.summary.max_loss), "neg", "engine, first expiry"));
  }

  function message(text) {
    dom.greeks.classList.add("hidden");
    Charts.empty(dom.chart, text);
    dom.note.textContent = "";
  }

  // ---------- draw --------------------------------------------------------------------
  async function draw() {
    if (!view) return;
    const isEngine = VIEWS.includes(tab);
    dom.controls.classList.toggle("hidden", !isEngine);
    if (!isEngine) {
      state.seq++;
      dom.greeks.classList.add("hidden");
      dom.note.textContent = TradeCharts.timeline(dom.chart, view.timeline);
      return;
    }
    const legs = Engine.positionLegs(view, state.which);
    if (!legs.length) return message("No open position to chart. Switch to “As opened” to see the original structure.");
    const list = days(legs);
    const i = selectedIndex(list, legs);
    syncControls(list, i);
    const spot = numVal(dom.spot) || view.underlying_entry;
    const ivPct = numVal(dom.iv) || view.iv_entry || Engine.DEFAULT_IV_PCT;
    let body;
    try {
      body = Engine.buildRequest(view, legs, { spot, ivPct, atMs: Engine.dayToMs(view, list, i) });
    } catch (err) {
      return message(err.message);
    }
    const seq = ++state.seq;
    let res;
    try {
      res = await price(body);
    } catch (err) {
      if (err.name === "AbortError") return;
      if (seq === state.seq) message(err.message);
      return;
    }
    if (seq !== state.seq) return;  // a newer request or tab took over
    const tIndex = Engine.nearestIndex(res.times, body.at_days[0]);
    const timesIso = Engine.timesToIso(view, res.times);
    dom.when.textContent = `${Fmt.dateTime(timesIso[tIndex])} NY · IV ${ivPct}% · American model`;
    const strikes = [...new Set(legs.filter((l) => l.kind !== "stock").map((l) => l.strike))];
    const ctx = { view, tIndex, timesIso, spot, strikes, underlying: view.underlying };
    dom.greeks.classList.remove("hidden");
    renderGreeks(res, tIndex);
    dom.note.textContent = TradeCharts[tab](dom.chart, res, ctx);
  }

  /** nodes: {controls, greeks, chart, note} */
  function mount(nodes) {
    dom = { ...nodes };
    buildControls();
  }

  function update(nextView) {
    view = nextView;
    // Until a tab is clicked, follow the trade: it can close (or reopen) as fills are edited.
    if (!state.picked) setWhich(Engine.defaultWhich(view));
    state.cacheKey = null;  // fills may have changed the position
    return draw();
  }

  function setTab(next) {
    tab = next;
    return draw();
  }

  root.TradePricing = { mount, update, setTab };
})(window);
