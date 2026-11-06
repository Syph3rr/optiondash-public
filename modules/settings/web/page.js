// Settings page: theme and pricing defaults (saved per browser through ODPrefs, from
// /shared/nav.js) and the TWS connection (Connect / Disconnect, in step with the nav chip
// through the broker:* window events). Server text only reaches textContent.
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const P = window.ODPrefs;
  const { LIMITS } = window.ODNav.prefs;

  let savedTimer = null;
  function flashSaved() {
    $('#saved').textContent = 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { $('#saved').textContent = ''; }, 1500);
  }

  function paintTheme(theme) {
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      const on = b.dataset.themeChoice === theme;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function wireTheme() {
    paintTheme(P.get().theme);
    document.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => {
      paintTheme(P.set({ theme: b.dataset.themeChoice }).theme);
      flashSaved();
    }));
  }

  /** Save a pricing default if it is a number in range; otherwise say why and keep the old one. */
  function wireNumber(key, label) {
    const input = $(`#${key}`);
    const [lo, hi] = LIMITS[key];
    input.value = String(P.get()[key]);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      const err = $('#rate-error');
      if (input.value.trim() === '' || !Number.isFinite(v) || v < lo || v > hi) {
        err.hidden = false;
        err.textContent = `${label} must be a number from ${lo} to ${hi}.`;
        input.value = String(P.get()[key]);
        return;
      }
      err.hidden = true;
      P.set({ [key]: v });
      flashSaved();
    });
  }

  // ---- TWS connection. Same protocol as the nav chip (see /shared/nav.js): one request per
  // press, broker:busy while acting, broker:changed afterwards, no timers, no polling.
  const SOURCE = 'settings';
  const REQUEST_MS = 20000;

  async function brokerCall(path, post) {
    const N = window.ODNav;
    const init = post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {};
    const signal = window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_MS) : undefined;
    const res = await fetch(path, { ...init, signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(N.failureText(res.status, body)), { status: res.status });
    return body;
  }

  const describe = (e) => (e && e.status ? e.message
    : (e && e.name === 'TimeoutError' ? 'TWS request timed out' : 'server not reachable'));
  const announce = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

  function wireTws() {
    const N = window.ODNav;
    const ui = { dot: $('#tws-dot'), msg: $('#tws-message'), connect: $('#tws-connect'), disconnect: $('#tws-disconnect') };
    const state = { status: null, busy: null, error: '', others: new Set() };
    let seq = 0;

    function render() {
      const v = window.SettingsTws.twsView({ ...state, locked: N.othersBusy(state.others, SOURCE) }, N.chipView);
      ui.dot.classList.toggle('on', v.connected);
      ui.msg.textContent = v.message;
      ui.msg.className = `st-value ${v.connected ? 'pos' : (v.tone === 'err' ? 'neg' : 'muted')}`;
      ui.connect.disabled = v.connect.disabled;
      ui.disconnect.disabled = v.disconnect.disabled;
    }

    async function refresh() {
      const mine = ++seq;
      try {
        const body = await brokerCall(N.BROKER.status, false);
        if (mine !== seq) return;
        state.error = N.keepError(state.status, body, state.error);
        state.status = body;
      } catch (e) {
        if (mine !== seq) return;
        state.status = null;
        state.error = describe(e);
      }
      render();
    }

    async function act(action) {
      if (state.busy || N.othersBusy(state.others, SOURCE)) return;
      seq++; // an in-flight status read must not overwrite what this action finds
      state.busy = action;
      state.error = '';
      render();
      announce(N.BUSY_EVENT, { source: SOURCE, busy: true });
      let failure = '';
      try {
        const reply = await brokerCall(N.BROKER[action], true);
        failure = action === 'connect' ? N.connectOutcome(reply) : '';
      } catch (e) {
        failure = describe(e);
      }
      state.busy = null;
      announce(N.BUSY_EVENT, { source: SOURCE, busy: false });
      await refresh();
      if (failure) state.error = failure; // the press's own failure stays visible
      render();
      announce(N.BROKER_EVENT, { source: SOURCE });
    }

    ui.connect.addEventListener('click', () => act('connect'));
    ui.disconnect.addEventListener('click', () => act('disconnect'));
    window.addEventListener('focus', () => { if (!state.busy) refresh(); });
    // The nav chip shares each status it reads; follow it without fetching.
    window.addEventListener(N.STATUS_EVENT, (e) => {
      const s = e.detail && e.detail.status;
      if (state.busy || !s) return;
      seq++;
      state.error = N.keepError(state.status, s, state.error);
      state.status = s;
      render();
    });
    window.addEventListener(N.BUSY_EVENT, (e) => {
      const d = e.detail || {};
      if (!d.source || d.source === SOURCE) return;
      if (d.busy) state.others.add(d.source); else state.others.delete(d.source);
      render();
    });
    render();
    refresh();
  }

  wireTheme();
  wireNumber('rate', 'Interest rate');
  wireNumber('divYield', 'Dividend yield');
  wireTws();
})();
