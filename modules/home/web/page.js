// Home page: loads every module's widget script, then mounts one card per registered widget.
// Cards read on load and on Refresh; nothing polls. A failing card shows its error and the
// others carry on. Server text only reaches textContent.
//
// Layout: "Edit layout" unlocks Home. Cards can then be dragged by their handle (or moved with
// ◀ ▶), resized (1, 2 or 3 columns), hidden (×) and added back (Add card). "Done" locks it
// again. The layout is saved in this browser (ODWidgets.layout); new cards appear at the end.
//
// Accounts: the header's picker is the account filter shared with Portfolio and Trades
// (/shared/accounts.js). Cards registered with `accounts: true` (the journal ones) are re-mounted
// when it changes, here or in another tab; a burst of changes mounts once (debounced), and a card
// only ever shows its newest mount (each mount gets a fresh body; older ones finish detached).
// Without accounts.js, or with the journal offline, Home shows all accounts as before.
(function () {
  'use strict';
  // Add a module's widget script here to put its cards on Home. A missing script (for example
  // the journal service being down) is skipped.
  // Scripts run in this order (each widget file after the helpers it needs).
  const WIDGET_SCRIPTS = [
    '/home/static/widgets.js',
    '/portfolio/static/portfolio.js',
    '/portfolio/static/widgets.js',
    // Journal analytics (what used to be the Dashboard page): helpers, then the cards.
    '/journal/static/js/format.js',
    '/journal/static/js/calendar.js',
    '/journal/static/js/ui.js',
    '/journal/static/js/api.js',
    '/journal/static/js/charts.js',
    '/journal/static/js/barlist.js',
    '/journal/static/js/opentrades.js',
    '/journal/static/js/dashboard.js',
    '/journal/static/js/widgets.js',
  ];
  // Stylesheets the cards above need.
  const WIDGET_STYLES = [
    '/journal/static/css/analytics.css',
  ];
  const SIZE_LABEL = { 1: 'Width: 1/3', 2: 'Width: 2/3', 3: 'Width: full' };

  const $ = (id) => document.getElementById(id);
  const L = ODWidgets.layout;
  const storage = (() => { try { return window.localStorage; } catch (_) { return null; } })();
  let layout = storage ? L.read(storage) : L.sanitize(null);
  const cards = new Map(); // id -> { w, root, body, sizeBtn }
  let sortable = null;
  const mounts = ODWidgets.createSequence(); // newest mount per card id
  const ACCOUNTS_DEBOUNCE_MS = 250;
  const Accounts = window.ODAccounts || null; // missing: all accounts, as before
  let accountList = [];
  let picker = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false; // added scripts then run in the order they were added
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.append(s);
    });
  }

  function loadStyle(href) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.append(l);
  }

  function save(next) {
    layout = storage ? L.write(storage, next) : L.sanitize(next);
  }

  /** The card order as it is on screen now (after a drag or a move). */
  const domOrder = () => [...$('grid').children].map((n) => n.dataset.id).filter(Boolean);
  const saveOrder = () => save(L.withOrder(layout, domOrder()));

  // ------------------------------------------------------------ cards

  function toolButton(text, title, onClick) {
    const b = el('button', 'wd-tool', text);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  function card(w) {
    const root = el('section', `card wd-${w.size}`);
    root.dataset.id = w.id;
    const head = el('div', 'card-h');
    const handle = el('span', 'wd-drag', '⠿');
    handle.title = 'Drag to move';
    handle.setAttribute('aria-hidden', 'true');
    head.append(handle, el('h2', '', w.title), el('span', 'grow'));
    if (w.link) {
      const a = el('a', 'wd-link', 'Open');
      a.href = w.link;
      head.append(a);
    }
    const tools = el('span', 'wd-tools');
    const sizeBtn = toolButton(SIZE_LABEL[w.size], 'Change the card width', () => resize(w.id));
    tools.append(
      toolButton('◀', `Move ${w.title} earlier`, () => move(w.id, -1)),
      toolButton('▶', `Move ${w.title} later`, () => move(w.id, 1)),
      sizeBtn,
      toolButton('×', `Hide ${w.title}`, () => hide(w.id)),
    );
    head.append(tools);
    const body = el('div', 'wd-body');
    body.append(el('div', 'skeleton'));
    root.append(head, body);
    return { w, root, body, sizeBtn };
  }

  /** Free a card's old charts (listeners, resize handlers) before its body is replaced. */
  function purgeCharts(root) {
    if (window.Plotly) root.querySelectorAll('.js-plotly-plot').forEach((n) => window.Plotly.purge(n));
  }

  /** Mount into a fresh body, so a slower, older mount of this card can only fill a detached node. */
  async function mountCard(c) {
    const token = mounts.next(c.w.id);
    purgeCharts(c.body);
    const body = el('div', 'wd-body');
    body.append(el('div', 'skeleton'));
    c.body.replaceWith(body);
    c.body = body;
    const res = await ODWidgets.safeMount(c.w, body, {});
    if (!mounts.isCurrent(c.w.id, token) || c.body !== body) {
      purgeCharts(body); // superseded by a newer mount: drop what this one drew
      return;
    }
    if (!res.ok) body.replaceChildren(el('div', 'wd-err', `Could not load: ${res.error}`));
  }

  /** Charts keep their old width when a card is resized or moved; redraw them to fit. */
  function refit(root) {
    if (!window.Plotly) return;
    requestAnimationFrame(() => root.querySelectorAll('.js-plotly-plot').forEach((n) => window.Plotly.Plots.resize(n)));
  }

  // ------------------------------------------------------------ edits

  function move(id, step) {
    const order = domOrder();
    const i = order.indexOf(id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= order.length) return;
    const node = cards.get(id).root;
    const other = cards.get(order[j]).root;
    // Moving the node blurs the button that was pressed; put focus back so ◀ ▶ can be repeated.
    const focused = node.contains(document.activeElement) ? document.activeElement : null;
    if (step < 0) other.before(node);
    else other.after(node);
    if (focused) focused.focus();
    saveOrder();
    refit(node);
  }

  function resize(id) {
    const c = cards.get(id);
    const current = L.arrange([c.w], layout)[0].size;
    const size = L.nextSize(current);
    save(L.withSize(layout, id, size));
    c.root.className = `card wd-${size}`;
    c.sizeBtn.textContent = SIZE_LABEL[size];
    refit(c.root);
  }

  function hide(id) {
    const c = cards.get(id);
    purgeCharts(c.root);
    c.root.remove();
    cards.delete(id);
    save(L.withHidden(layout, id, true));
    saveOrder();
    paintAddMenu();
  }

  function show(id) {
    const w = L.arrange(ODWidgets.list(), layout).find((x) => x.id === id);
    if (!w) return;
    save(L.withHidden(layout, id, false));
    const c = card({ ...w, hidden: false });
    cards.set(id, c);
    $('grid').append(c.root);
    saveOrder();
    paintAddMenu();
    mountCard(c);
    c.root.scrollIntoView({ block: 'nearest' });
  }

  function paintAddMenu() {
    const hidden = L.arrange(ODWidgets.list(), layout).filter((w) => w.hidden);
    const pick = $('add-card');
    const first = el('option', '', hidden.length ? 'Add a card…' : 'All cards are shown');
    first.value = '';
    pick.replaceChildren(first, ...hidden.map((w) => {
      const o = el('option', '', w.title);
      o.value = w.id;
      return o;
    }));
    pick.disabled = !hidden.length;
  }

  function setLocked(locked) {
    save(L.withLocked(layout, locked));
    document.querySelector('main.home').classList.toggle('editing', !locked);
    $('edit-layout').hidden = !locked;
    $('layout-tools').hidden = locked;
    if (sortable) sortable.option('disabled', locked);
    if (!locked) paintAddMenu();
  }

  // ------------------------------------------------------------ build

  async function build() {
    const grid = $('grid');
    purgeCharts(grid);
    cards.clear();
    const shown = L.arrange(ODWidgets.list(), layout).filter((w) => !w.hidden);
    shown.forEach((w) => cards.set(w.id, card(w)));
    grid.replaceChildren(...[...cards.values()].map((c) => c.root));
    await refresh();
  }

  /** The TWS status pill in the header (the full TWS card is an optional add-on). */
  async function paintTws() {
    const pill = $('tws-pill');
    try {
      const res = await fetch('/api/broker/status');
      const s = await res.json();
      const offline = !s || s.sidecar === 'offline';
      const connected = !offline && s.ibkr === 'connected';
      pill.className = `tws-pill ${connected ? 'ok' : offline ? 'err' : ''}`;
      pill.textContent = connected ? 'TWS connected' : offline ? 'Market service offline' : 'TWS not connected';
      pill.title = connected ? 'Read-only connection, shared by the whole app' : (s && s.reason) || 'Use Connect in the sidebar when TWS is open';
    } catch (_) {
      pill.className = 'tws-pill err';
      pill.textContent = 'TWS status unknown';
      pill.title = 'Could not reach the server';
    }
  }

  const stamp = () => { $('asof').textContent = `Updated ${new Date().toLocaleTimeString('en-AU')}`; };

  async function refresh() {
    $('refresh').disabled = true;
    paintTws();
    await Promise.all([...cards.values()].map(mountCard));
    $('refresh').disabled = false;
    stamp();
  }

  // ------------------------------------------------------------ account filter

  /** "Showing IBKR only" beside the picker while not every account is selected. */
  function paintAccountNote() {
    const note = $('acc-note');
    const text = Accounts ? ODWidgets.accountsNote(accountList, Accounts.selected(accountList)) : '';
    note.textContent = text;
    note.hidden = !text;
  }

  /** The account list (cached by ODAccounts). If it never loads, query() is '' (all accounts);
   *  if a later reload fails, ODAccounts keeps filtering by the last list, and so does the note. */
  async function loadAccounts(fresh) {
    if (!Accounts) return;
    try {
      accountList = await (fresh ? Accounts.reload() : Accounts.load());
    } catch (_) {
      /* keep the last list */
    }
    paintAccountNote();
  }

  /** A disabled stand-in for the picker when accounts.js itself did not load. */
  function pickerUnavailable(holder) {
    const b = el('button', 'btn', 'Accounts: unavailable');
    b.type = 'button';
    b.disabled = true;
    b.title = 'The account filter could not load; showing all accounts';
    holder.replaceChildren(b);
  }

  async function startAccounts() {
    const holder = $('acc-picker');
    if (!Accounts) return pickerUnavailable(holder);
    // The picker shows its own "unavailable" state if the journal is down.
    picker = await Accounts.picker(holder).catch(() => { pickerUnavailable(holder); return null; });
    await loadAccounts(false);
  }

  const remountAccountCards = ODWidgets.debounce(async () => {
    paintAccountNote();
    await Promise.all([...cards.values()].filter((c) => c.w.accounts).map(mountCard));
    stamp();
  }, ACCOUNTS_DEBOUNCE_MS);

  /** Refresh also re-reads the accounts (a rename or a new account in Settings). */
  async function refreshAll() {
    if (picker) await picker.refresh(); // reloads the shared list...
    await loadAccounts(!picker);        // ...so read it from the cache, or reload it ourselves
    await refresh();
  }

  function wireLayout() {
    if (window.Sortable) {
      sortable = window.Sortable.create($('grid'), {
        // Pointer-based dragging (not the browser's native drag-and-drop): the same on every
        // browser and for touch, and the dragged card follows the cursor.
        handle: '.wd-drag', animation: 150, ghostClass: 'wd-ghost', chosenClass: 'wd-chosen',
        forceFallback: true, fallbackClass: 'wd-dragging',
        disabled: layout.locked,
        onEnd: (e) => { saveOrder(); refit(e.item); },
      });
    }
    $('edit-layout').addEventListener('click', () => setLocked(false));
    $('done-layout').addEventListener('click', () => setLocked(true));
    $('reset-layout').addEventListener('click', async () => {
      save({ ...L.DEFAULT, locked: false });
      await build();
      paintAddMenu();
    });
    $('add-card').addEventListener('change', (e) => {
      if (e.target.value) show(e.target.value);
    });
    setLocked(layout.locked);
  }

  async function start() {
    WIDGET_STYLES.forEach(loadStyle);
    // Widget scripts and the accounts list load in parallel; cards mount once both are in, so the
    // first fetch already carries the filter.
    await Promise.all([Promise.all(WIDGET_SCRIPTS.map(loadScript)), startAccounts()]);
    wireLayout();
    await build();
  }

  $('refresh').addEventListener('click', refreshAll);
  window.addEventListener('od:accounts', remountAccountCards);
  start();
})();
