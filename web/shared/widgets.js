// Widget registry for the Home page. Any module can add a card to Home by loading a script
// that calls ODWidgets.register({...}) before Home starts:
//
//   ODWidgets.register({
//     id: 'journal-equity',        // unique, kebab-case
//     title: 'Equity curve',       // card heading
//     size: 2,                     // columns wide, 1 to 3 (default 1)
//     order: 20,                   // lower first; widgets with no order go last
//     link: '/journal/',           // optional: "open" link on the card
//     optional: true,              // optional: off by default; added from Edit layout > Add card
//     accounts: true,              // optional: shows journal data, so Home re-mounts it when the
//                                  // account filter (ODAccounts) changes; fetch through
//                                  // ODWidgets.withAccounts(url) to apply the filter
//     mount(el, ctx) { ... }       // fill `el`; may be async; throwing only breaks this card
//   });
//
// Pure registry logic only (no DOM), so Node tests can load this file directly.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.ODWidgets = api.createRegistry(); // the page-wide registry
    root.ODWidgets.createRegistry = api.createRegistry;
    root.ODWidgets.safeMount = api.safeMount;
    root.ODWidgets.layout = api.layout;
    // The page's account filter, read at call time (accounts.js may be missing: then all accounts).
    root.ODWidgets.withAccounts = (url) => api.withAccounts(url, root.ODAccounts);
    root.ODWidgets.accountsNote = api.accountsNote;
    root.ODWidgets.debounce = api.debounce;
    root.ODWidgets.createSequence = api.createSequence;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clampSize = (n) => (Number.isInteger(n) ? Math.min(3, Math.max(1, n)) : 1);

  function createRegistry() {
    const items = [];

    function register(widget) {
      if (!widget || typeof widget !== 'object') throw new Error('widget must be an object');
      if (typeof widget.id !== 'string' || !widget.id) throw new Error('widget needs an id');
      if (typeof widget.title !== 'string' || !widget.title) throw new Error(`widget ${widget.id} needs a title`);
      if (typeof widget.mount !== 'function') throw new Error(`widget ${widget.id} needs a mount function`);
      if (items.some((w) => w.id === widget.id)) throw new Error(`widget ${widget.id} is already registered`);
      items.push({ ...widget, size: clampSize(widget.size), accounts: Boolean(widget.accounts) });
    }

    /** Copies, ordered by `order` (missing last), ties in registration order. */
    function list() {
      const rank = (w) => (Number.isFinite(w.order) ? w.order : Infinity);
      return items.map((w, i) => ({ w: { ...w }, i }))
        .sort((a, b) => (rank(a.w) === rank(b.w) ? a.i - b.i : rank(a.w) < rank(b.w) ? -1 : 1))
        .map((x) => x.w);
    }

    return { register, list };
  }

  /** Runs a widget's mount; a failure (sync or async) is reported, never thrown. */
  async function safeMount(widget, el, ctx) {
    try {
      await widget.mount(el, ctx);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }


  // ------------------------------------------------------------ Home layout
  // What the viewer did to Home: card order, hidden cards, optional cards they added, per-card
  // sizes, and whether editing is locked. Saved per browser. Cards a module adds later appear at
  // the end (or stay off, if optional). v2: Home's default set changed, so old layouts restart.
  const LAYOUT_KEY = 'od.home.layout.v2';
  const DEFAULT = Object.freeze({ order: [], hidden: [], shown: [], sizes: {}, locked: true });
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

  function sanitize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const sizes = {};
    if (r.sizes && typeof r.sizes === 'object') {
      for (const [k, v] of Object.entries(r.sizes)) if (Number.isInteger(v)) sizes[k] = clampSize(v);
    }
    return { order: [...new Set(ids(r.order))], hidden: [...new Set(ids(r.hidden))],
      shown: [...new Set(ids(r.shown))], sizes, locked: typeof r.locked === 'boolean' ? r.locked : true };
  }

  /** Widgets in display order with the layout's size and a `hidden` flag (an optional widget is
   *  hidden until the viewer adds it). Inputs are not changed. */
  function arrange(widgets, layout) {
    const l = sanitize(layout);
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const first = l.order.filter((id) => byId.has(id));
    const rest = widgets.map((w) => w.id).filter((id) => !first.includes(id));
    return [...first, ...rest].map((id) => {
      const w = byId.get(id);
      const hidden = l.hidden.includes(id) || (Boolean(w.optional) && !l.shown.includes(id));
      return { ...w, size: l.sizes[id] ? clampSize(l.sizes[id]) : clampSize(w.size), hidden };
    });
  }

  const withOrder = (layout, order) => ({ ...sanitize(layout), order: [...new Set(ids(order))] });
  /** Hide or show a card. Showing records it in `shown` too, so an optional card stays on. */
  const withHidden = (layout, id, hidden) => {
    const l = sanitize(layout);
    const without = (list) => list.filter((x) => x !== id);
    return hidden
      ? { ...l, hidden: [...without(l.hidden), id], shown: without(l.shown) }
      : { ...l, hidden: without(l.hidden), shown: [...without(l.shown), id] };
  };
  const withSize = (layout, id, size) => {
    const l = sanitize(layout);
    return { ...l, sizes: { ...l.sizes, [id]: clampSize(size) } };
  };
  const withLocked = (layout, locked) => ({ ...sanitize(layout), locked: Boolean(locked) });
  const nextSize = (size) => (clampSize(size) % 3) + 1;

  function readLayout(storage) {
    try {
      return sanitize(JSON.parse(storage.getItem(LAYOUT_KEY)));
    } catch (_) {
      return sanitize(null);
    }
  }
  function writeLayout(storage, layout) {
    const l = sanitize(layout);
    try { storage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch (_) { /* private mode: not saved */ }
    return l;
  }

  const layout = { DEFAULT, KEY: LAYOUT_KEY, sanitize, arrange, withOrder, withHidden, withSize, withLocked,
    nextSize, read: readLayout, write: writeLayout };

  // ------------------------------------------------------------ account filter
  // Home's journal cards follow the shared account filter (web/shared/accounts.js).

  /** `url` with `query` appended after the right separator; unchanged when `query` is empty. */
  function withQuery(url, query) {
    if (!query) return url;
    if (!url.includes('?')) return `${url}?${query}`;
    return /[?&]$/.test(url) ? `${url}${query}` : `${url}&${query}`;
  }

  /** `url` filtered to the selected accounts. No filter, or a broken one, means all accounts. */
  function withAccounts(url, accounts) {
    let query = '';
    try {
      query = accounts && typeof accounts.query === 'function' ? accounts.query() : '';
    } catch (_) {
      query = '';
    }
    return withQuery(url, typeof query === 'string' ? query : '');
  }

  const NOTE_NAMES_MAX = 2; // more selected accounts than this and the note counts them

  /** '' when every account (or none) is selected, else "Showing IBKR only" / "Showing 3 of 5 accounts". */
  function accountsNote(accounts, selected) {
    const list = Array.isArray(accounts) ? accounts : [];
    const keep = new Set(Array.isArray(selected) ? selected : []);
    const chosen = list.filter((a) => keep.has(a.id));
    if (!chosen.length || chosen.length === list.length) return '';
    if (chosen.length > NOTE_NAMES_MAX) return `Showing ${chosen.length} of ${list.length} accounts`;
    return `Showing ${chosen.map((a) => a.name).join(' and ')} only`;
  }

  /** `fn` called once, `ms` after the last of a burst of calls, with the last call's arguments. */
  function debounce(fn, ms, setTimer = setTimeout, clearTimer = clearTimeout) {
    let timer = null;
    return (...args) => {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => { timer = null; fn(...args); }, ms);
    };
  }

  /** Per-key tokens: a result is shown only if its token is still the newest for its key. */
  function createSequence() {
    const latest = new Map();
    return {
      next(key) {
        const token = (latest.get(key) || 0) + 1;
        latest.set(key, token);
        return token;
      },
      isCurrent: (key, token) => latest.has(key) && latest.get(key) === token,
    };
  }

  return { createRegistry, safeMount, layout, withQuery, withAccounts, accountsNote, debounce, createSequence };
});
