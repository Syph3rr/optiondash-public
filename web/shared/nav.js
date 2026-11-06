// Platform nav bar shared by every module. Include it in <head>; it inserts itself at the
// top of <body> and highlights the current section. Built with DOM calls only (no HTML
// strings). Pure helpers are exported for Node tests.
//
// The right end carries the shared TWS chip. It reads /api/broker/status on page load, when
// the window regains focus, and on the "broker:changed" window event. It never polls and
// never connects on its own: Connect is one attempt per press.
//
// Window events (CustomEvent, detail.source names the sender so nobody reacts to itself):
//   broker:changed  {source}               "the connection may have changed — re-read it"
//   broker:status   {source:'nav', status} the chip's latest status body (null if unknown);
//                                          pages can follow it without fetching. Listeners
//                                          must not re-dispatch anything from it.
//   broker:busy     {source, busy}         a component started/finished connect/disconnect;
//                                          everyone else disables their Connect meanwhile.
(function (root) {
  'use strict';

  // THE MODULE REGISTRY. To add a section to the sidebar, add an entry here (and nothing
  // else in this file). `pages` are the links; `match` is a RegExp source tested against the
  // normalised path to decide which page is current. Entries with `soon: true` show greyed
  // out and are not links. Groups appear in the order first used.
  const MODULES = [
    { id: 'home', group: 'Overview', icon: 'H', pages: [
      { id: 'home', label: 'Home', href: '/home', match: '^/home$' } ] },
    { id: 'portfolio', group: 'Overview', icon: 'P', pages: [
      { id: 'portfolio', label: 'Portfolio', href: '/portfolio', match: '^/portfolio$' } ] },
    { id: 'analyser', group: 'Analysis', icon: 'A', pages: [
      { id: 'analyser', label: 'Options Analyser', href: '/', match: '^/$' } ] },
    { id: 'chain', group: 'Analysis', icon: 'C', pages: [
      { id: 'chain', label: 'Chain & screener', href: '/chain', match: '^/chain$' } ] },
    // New trade and IBKR fill import are panels on the Trades page; the Dashboard is on Home.
    // The TWS connection (Connect/Disconnect) lives in Settings and on the chip below.
    { id: 'journal', group: 'Journal', icon: 'J', pages: [
      { id: 'trades', label: 'Trades', href: '/journal/', match: '^/journal(/trade)?$' } ] },
    // `pinned` groups sit at the bottom of the sidebar, just above the TWS chip.
    { id: 'settings', group: 'Settings', icon: 'S', pinned: true, pages: [
      { id: 'settings', label: 'Settings', href: '/settings', match: '^/settings$' } ] },
  ];

  /** Flat list of live (linkable) pages, in registry order. */
  const SECTIONS = MODULES.filter((m) => !m.soon)
    .flatMap((m) => m.pages.map((p) => ({ id: p.id, label: p.label, href: p.href, match: p.match })));

  const BROKER = {
    status: '/api/broker/status',
    connect: '/api/broker/connect',
    disconnect: '/api/broker/disconnect',
  };
  const BROKER_EVENT = 'broker:changed';
  const STATUS_EVENT = 'broker:status';
  const BUSY_EVENT = 'broker:busy';
  const REQUEST_MS = 20000;
  const NOTE_CHARS = 48;

  /** Which section a URL path belongs to (null when none matches). */
  function activeSection(pathname) {
    const path = String(pathname || '/').replace(/\/+$/, '') || '/';
    const hit = SECTIONS.find((p) => new RegExp(p.match).test(path));
    return hit ? hit.id : null;
  }

  // ---------------------------------------------------------------- TWS chip (pure)

  const reasonText = (x) => (typeof x === 'string' && x.trim() ? x.trim() : '');
  const HIDDEN = Object.freeze({ text: '', action: null, disabled: true, hidden: true });

  /**
   * Chip view from broker state. `status` is the /api/broker/status body (null before the
   * first answer), `busy` is 'connect' | 'disconnect' | null, `error` the last failure text.
   * @returns {{tone: string, label: string, title: string,
   *            button: {text: string, action: string|null, disabled: boolean, hidden: boolean}}}
   */
  function chipView({ status = null, busy = null, error = '', locked = false } = {}) {
    const view = baseView(status, busy, reasonText(error));
    const note = truncate(reasonText(error), NOTE_CHARS);
    if (locked && !busy && !view.button.hidden) {
      return { ...view, note, button: { ...view.button, disabled: true },
        title: `${view.title} — another part of the app is connecting…` };
    }
    return { ...view, note };
  }

  /** Short visible form of an error; the full text stays in the tooltip. */
  function truncate(text, max) {
    const t = reasonText(text);
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  }

  /** An error stays shown until the next action or until the connection state changes. */
  function keepError(prev, next, error) {
    if (!error) return '';
    if (!prev || !next) return error;
    return prev.ibkr === next.ibkr && prev.sidecar === next.sidecar ? error : '';
  }

  /** Whether any OTHER component is mid connect/disconnect, from a busy-source set. */
  function othersBusy(busySources, self) {
    return [...busySources].some((s) => s !== self);
  }

  function baseView(status, busy, err) {
    if (busy) {
      const text = busy === 'disconnect' ? 'Disconnecting…' : 'Connecting…';
      return { tone: 'busy', label: 'TWS …', title: text,
        button: { text, action: null, disabled: true, hidden: false } };
    }
    const button = (text, action) => ({ text, action, disabled: false, hidden: false });
    if (!status) {
      if (err) return { tone: 'err', label: 'TWS error', title: err, button: HIDDEN };
      return { tone: 'off', label: 'TWS …', title: 'Checking the TWS connection', button: HIDDEN };
    }
    const reason = reasonText(status.reason);
    if (status.sidecar && status.sidecar !== 'online') {
      return { tone: 'err', label: 'TWS error',
        title: err || reason || 'market data service offline', button: HIDDEN };
    }
    if (status.ibkr === 'connected') {
      return { tone: err ? 'err' : 'ok', label: err ? 'TWS error' : 'TWS connected',
        title: err || reason || 'Connected to TWS (read-only)', button: button('Disconnect', 'disconnect') };
    }
    return { tone: err ? 'err' : 'off', label: err ? 'TWS error' : 'TWS off',
      title: err || reason || 'Not connected to TWS. Press Connect.', button: button('Connect', 'connect') };
  }

  /** Error text for a failed broker reply: the server's own message when it gave one. */
  function failureText(httpStatus, body) {
    const msg = body && (body.error || body.message);
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
    if (httpStatus === 409) return 'not connected to TWS';
    return `TWS request failed (${httpStatus})`;
  }

  /** A connect reply that came back 200 but left TWS disconnected is still a failure to show. */
  function connectOutcome(reply) {
    if (reply && reply.ibkr && reply.ibkr !== 'connected') return reasonText(reply.reason) || 'TWS not connected';
    return '';
  }

  // ---------------------------------------------------------------- DOM

  function build(doc, pathname) {
    const nav = doc.createElement('nav');
    nav.className = 'od-nav';
    nav.setAttribute('aria-label', 'Sections');
    const brand = doc.createElement('a');
    brand.className = 'brand';
    brand.href = '/';
    brand.appendChild(doc.createElement('i'));
    brand.appendChild(doc.createTextNode('OptionDash'));
    nav.appendChild(brand);
    const current = activeSection(pathname);
    let group = null;
    let pinned = false;
    for (const m of MODULES) {
      if (m.pinned && !pinned) {
        pinned = true;
        const spacer = doc.createElement('div');
        spacer.className = 'od-spacer';
        nav.appendChild(spacer);
      }
      if (m.group !== group) {
        group = m.group;
        const h = doc.createElement('div');
        h.className = 'od-group';
        h.textContent = group;
        nav.appendChild(h);
      }
      for (const p of m.pages) nav.appendChild(navItem(doc, m, p, current));
    }
    return nav;
  }

  function navItem(doc, mod, page, current) {
    const live = !mod.soon;
    const a = doc.createElement(live ? 'a' : 'span');
    a.textContent = page.label;
    if (live) {
      a.href = page.href;
    } else {
      a.className = 'soon-item';
      a.setAttribute('aria-disabled', 'true');
      a.title = 'Coming soon';
    }
    if (live && page.id === current) {
      a.className = 'on';
      a.setAttribute('aria-current', 'page');
    }
    return a;
  }

  function buildChip(doc) {
    const chip = doc.createElement('span');
    chip.className = 'od-tws off';
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', 'TWS connection');
    const label = doc.createElement('span');
    label.className = 'od-tws-label';
    // Visible failure text, announced politely; the full text stays in the tooltip.
    const note = doc.createElement('span');
    note.className = 'od-tws-note';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'od-tws-btn';
    chip.appendChild(doc.createElement('i'));
    chip.appendChild(label);
    chip.appendChild(note);
    chip.appendChild(btn);
    return { chip, label, note, btn };
  }

  /** Server text only ever reaches title/textContent, never HTML. */
  function paint(ui, view) {
    ui.chip.className = `od-tws ${view.tone}`;
    ui.chip.title = view.title;
    ui.label.textContent = view.label;
    ui.note.textContent = view.note || '';
    ui.note.title = view.note ? view.title : '';
    ui.btn.textContent = view.button.text;
    ui.btn.hidden = view.button.hidden;
    ui.btn.disabled = view.button.disabled;
    ui.btn.dataset.action = view.button.action || '';
  }

  async function brokerCall(win, path, post) {
    const init = post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {};
    const timeout = win.AbortSignal && win.AbortSignal.timeout;
    const res = await win.fetch(path, { ...init, signal: timeout ? win.AbortSignal.timeout(REQUEST_MS) : undefined });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(failureText(res.status, body)), { status: res.status });
    return body;
  }

  const describe = (e) => (e && e.status ? e.message
    : (e && e.name === 'TimeoutError' ? 'TWS request timed out' : 'server not reachable'));

  const emit = (win, name, detail) => win.dispatchEvent(new win.CustomEvent(name, { detail }));

  /**
   * Refresh on load, focus and broker:changed; one request per button press. No timers.
   * One status GET at a time: calls made while one is in flight coalesce into a single
   * follow-up read, and a sequence number drops any answer an action has made stale.
   */
  function wireBroker(win, ui) {
    const state = { status: null, busy: null, error: '', others: new Set() };
    const render = () => paint(ui, chipView({ ...state, locked: othersBusy(state.others, 'nav') }));
    let seq = 0;
    let inflight = null;
    let again = false;

    function refresh() {
      if (inflight) {
        again = true;
        return inflight;
      }
      const mine = ++seq;
      inflight = (async () => {
        try {
          const body = await brokerCall(win, BROKER.status, false);
          if (mine === seq) {
            state.error = keepError(state.status, body, state.error);
            state.status = body;
          }
        } catch (e) {
          if (mine === seq) {
            state.status = null;
            state.error = describe(e);
          }
        } finally {
          inflight = null;
          render();
          emit(win, STATUS_EVENT, { source: 'nav', status: state.status });
          if (again) {
            again = false;
            refresh();
          }
        }
      })();
      return inflight;
    }

    async function settle() {
      await refresh();
      while (inflight) await inflight;
    }

    async function act(action) {
      if (state.busy || !BROKER[action] || action === 'status' || othersBusy(state.others, 'nav')) return;
      seq++; // a status answer already in flight must not overwrite what this action finds
      state.busy = action;
      state.error = '';
      render();
      emit(win, BUSY_EVENT, { source: 'nav', busy: true });
      let failure = '';
      try {
        const reply = await brokerCall(win, BROKER[action], true);
        failure = action === 'connect' ? connectOutcome(reply) : '';
      } catch (e) {
        failure = describe(e);
      }
      state.busy = null;
      emit(win, BUSY_EVENT, { source: 'nav', busy: false });
      await settle();
      if (failure) state.error = failure; // the press's own failure stays visible
      render();
      emit(win, BROKER_EVENT, { source: 'nav' });
    }

    ui.btn.addEventListener('click', () => act(ui.btn.dataset.action));
    win.addEventListener('focus', () => refresh());
    win.addEventListener(BROKER_EVENT, (e) => {
      if (!(e.detail && e.detail.source === 'nav')) refresh();
    });
    win.addEventListener(BUSY_EVENT, (e) => {
      const d = e.detail || {};
      if (!d.source || d.source === 'nav') return;
      if (d.busy) state.others.add(d.source);
      else state.others.delete(d.source);
      render();
    });
    render();
    refresh();
    return { refresh, act, state };
  }

  function mount(doc, win) {
    if (doc.querySelector('nav.od-nav')) return;
    const nav = build(doc, doc.location.pathname);
    const ui = buildChip(doc);
    nav.appendChild(ui.chip);
    doc.body.classList.add('od-shell');
    doc.body.insertBefore(nav, doc.body.firstChild);
    wireBroker(win, ui);
  }


  // ---------------------------------------------------------------- preferences & theme
  // Per-browser preferences: the theme, and the pricing defaults pages start from (rate and
  // dividend yield, in %). Stored in localStorage; a blocked or broken storage falls back to
  // the defaults and never throws. Pure helpers are exported for Node tests.
  const PREFS_KEY = 'od.prefs';
  const PREFS_EVENT = 'od:prefs';
  const THEMES = ['system', 'dark', 'light'];
  const DEFAULTS = Object.freeze({ theme: 'system', rate: 4, divYield: 1.3 });
  const LIMITS = { rate: [-5, 25], divYield: [0, 20] };

  const inRange = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

  /** A clean preferences object: valid fields kept, anything else back to its default. */
  function sanitize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      theme: THEMES.includes(r.theme) ? r.theme : DEFAULTS.theme,
      rate: inRange(r.rate, LIMITS.rate) ? r.rate : DEFAULTS.rate,
      divYield: inRange(r.divYield, LIMITS.divYield) ? r.divYield : DEFAULTS.divYield,
    };
  }

  /** The theme to show: 'dark' or 'light'. `prefersLight` is the OS setting. */
  function resolveTheme(pref, prefersLight) {
    if (pref === 'dark' || pref === 'light') return pref;
    return prefersLight ? 'light' : 'dark';
  }

  function readPrefs(storage) {
    try {
      return sanitize(JSON.parse(storage.getItem(PREFS_KEY)));
    } catch (_) {
      return sanitize(null);
    }
  }

  /** Merge `patch` into the stored preferences; returns the new preferences. */
  function writePrefs(storage, patch) {
    const next = sanitize({ ...readPrefs(storage), ...patch });
    try { storage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (_) { /* private mode: not saved */ }
    return next;
  }

  const prefs = { DEFAULTS, LIMITS, THEMES, sanitize, resolveTheme, read: readPrefs, write: writePrefs };

  /** Browser side: apply the theme now (before the page paints) and keep it current. */
  function themeRuntime(win) {
    const doc = win.document;
    let storage = null;
    try { storage = win.localStorage; } catch (_) { /* blocked: defaults only */ }
    const media = win.matchMedia ? win.matchMedia('(prefers-color-scheme: light)') : null;
    const get = () => (storage ? readPrefs(storage) : sanitize(null));
    const apply = () => {
      doc.documentElement.dataset.theme = resolveTheme(get().theme, !!(media && media.matches));
    };
    const set = (patch) => {
      const next = storage ? writePrefs(storage, patch) : sanitize({ ...get(), ...patch });
      apply();
      win.dispatchEvent(new win.CustomEvent(PREFS_EVENT, { detail: next }));
      return next;
    };
    /** The current theme's colours, for charts (read when a chart is drawn). */
    const colors = () => {
      const cs = win.getComputedStyle(doc.documentElement);
      const v = (name) => cs.getPropertyValue(name).trim();
      return {
        bg: v('--bg'), panel: v('--panel'), panel2: v('--panel-2'), line: v('--line'), line2: v('--line-2'),
        text: v('--text'), muted: v('--muted'), faint: v('--faint'), accent: v('--accent'), blue: v('--blue'),
        pos: v('--pos'), neg: v('--neg'), posBg: v('--pos-bg'), negBg: v('--neg-bg'),
        zero: v('--chart-zero'), hover: v('--chart-hover'), heatMid: v('--heat-mid'),
        heat: [v('--heat-1'), v('--heat-2'), v('--heat-3'), v('--heat-4'), v('--heat-5')],
        violet: v('--violet'), violetBg: v('--violet-bg'),
      };
    };
    apply();
    if (media && media.addEventListener) media.addEventListener('change', apply);
    win.addEventListener('storage', (e) => { if (e.key === PREFS_KEY) apply(); });
    return { get, set, apply, colors, EVENT: PREFS_EVENT };
  }

  const api = {
    prefs, MODULES, SECTIONS, BROKER, BROKER_EVENT, STATUS_EVENT, BUSY_EVENT, activeSection, build, chipView,
    failureText, connectOutcome, truncate, keepError, othersBusy, wireBroker, buildChip,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ODNav = api;
    root.ODPrefs = themeRuntime(root); // theme applied here, in <head>, before first paint
    const go = () => mount(root.document, root);
    if (root.document.body) go();
    else root.document.addEventListener('DOMContentLoaded', go);
  }
})(typeof window !== 'undefined' ? window : globalThis);
