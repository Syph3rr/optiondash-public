// The one account filter shared by Home, Portfolio and Trades (window.ODAccounts).
//
//   const accounts = await ODAccounts.load();      // GET /api/journal/accounts, cached per page
//   ODAccounts.selected(accounts)                   // -> [1, 2]: selected ids (default: all)
//   ODAccounts.query(accounts)                      // -> '' (all) or 'accounts=1,2' for journal URLs
//   ODAccounts.setSelected([1])                     // store + fire window 'od:accounts' {selected}
//   ODAccounts.picker(containerEl)                  // compact "Accounts: All" button + popover
//   window.addEventListener('od:accounts', (e) => refresh(e.detail.selected));
//   await ODAccounts.changed()                      // after adding/renaming/deleting accounts:
//                                                   // reload, tell other tabs, fire 'od:accounts'
//
// The choice is remembered per browser under KEY as the *excluded* ids, so an account added
// later is selected by default and a deleted one simply drops out. Changes made in another tab
// arrive as the same 'od:accounts' event. Pure logic is exported for Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ODAccounts = api.browser(root);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'optiondash.accounts.selected';
  const CHANGED_KEY = 'optiondash.accounts.changed';  // a stamp: the account list itself changed
  const EVENT = 'od:accounts';
  const URL = '/api/journal/accounts';
  const LABEL_MAX = 24;  // longer than this and the button says "2 of 3" instead of names
  const TYPE_LABEL = { ibkr: 'IBKR', paper: 'Paper', other: 'Other' };

  const isId = (n) => Number.isInteger(n) && n > 0;
  const ids = (accounts) => (Array.isArray(accounts) ? accounts.map((a) => a.id) : []);

  // ------------------------------------------------------------ pure logic

  /** Selected ids, in list order: every account not excluded. Never empty unless there are no accounts. */
  function selectedFrom(accounts, excluded) {
    const all = ids(accounts);
    const out = new Set(excluded || []);
    const chosen = all.filter((id) => !out.has(id));
    return chosen.length ? chosen : all;
  }

  /** The ids to store: every listed account that is not selected, ascending. */
  function excludedFrom(accounts, selected) {
    const keep = new Set(selected || []);
    return ids(accounts).filter((id) => !keep.has(id)).sort((a, b) => a - b);
  }

  /** '' when every account is selected (or none would be), else 'accounts=1,2' (known ids, ascending). */
  function queryFor(accounts, selected) {
    const all = ids(accounts);
    const known = new Set(all);
    const chosen = [...new Set(selected || [])].filter((id) => known.has(id)).sort((a, b) => a - b);
    if (!chosen.length || chosen.length === all.length) return '';
    return `accounts=${chosen.join(',')}`;
  }

  /** "Accounts: All", "Accounts: IBKR, Paper" when the names are short, else "Accounts: 2 of 3". */
  function labelFor(accounts, selected) {
    const list = Array.isArray(accounts) ? accounts : [];
    const keep = new Set(selected || []);
    const chosen = list.filter((a) => keep.has(a.id));
    if (!chosen.length || chosen.length === list.length) return 'Accounts: All';
    const names = chosen.map((a) => a.name).join(', ');
    if (chosen.length <= 2 && names.length <= LABEL_MAX) return `Accounts: ${names}`;
    return `Accounts: ${chosen.length} of ${list.length}`;
  }

  function readExcluded(storage) {
    try {
      const raw = storage && storage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? [...new Set(parsed.filter(isId))] : [];
    } catch (_) {
      return [];
    }
  }

  function writeExcluded(storage, excluded) {
    const clean = [...new Set((excluded || []).filter(isId))].sort((a, b) => a - b);
    try { storage.setItem(KEY, JSON.stringify(clean)); } catch (_) { /* private mode: not remembered */ }
    return clean;
  }

  // ------------------------------------------------------------ the page's store

  /**
   * deps: fetchJson(url) -> Promise of the `data` of an {ok, data, error} reply;
   * storage (localStorage-like, may throw); target (EventTarget: window in the browser);
   * doc (document, only for picker).
   */
  function createAccounts(deps) {
    const { fetchJson, storage, target, doc } = deps;
    let cache = null;     // the last loaded list
    let pending = null;   // the load in flight (or done) for this page

    function emit(selected) {
      target.dispatchEvent(new CustomEvent(EVENT, { detail: { selected } }));
    }

    function load() {
      if (!pending) {
        pending = Promise.resolve().then(() => fetchJson(URL)).then((list) => {
          cache = Array.isArray(list) ? list : [];
          return cache;
        }, (err) => {
          pending = null;  // let the next call retry
          throw err;
        });
      }
      return pending;
    }

    function reload() {
      pending = null;
      return load();
    }

    const listOr = (accounts) => (Array.isArray(accounts) ? accounts : cache || []);
    const selected = (accounts) => selectedFrom(listOr(accounts), readExcluded(storage));
    const query = (accounts) => queryFor(listOr(accounts), selected(accounts));

    function setSelected(chosen) {
      if (!cache) throw new Error('ODAccounts.setSelected: load() the accounts first');
      const known = new Set(ids(cache));
      const keep = [...new Set(chosen || [])].filter((id) => known.has(id));
      if (!keep.length) throw new Error('ODAccounts.setSelected: select at least one account');
      writeExcluded(storage, excludedFrom(cache, keep));
      const now = selected(cache);
      emit(now);
      return now;
    }

    /** The account list changed (added, renamed, reordered, deleted): reload it, stamp storage so
     *  other tabs reload too, and fire 'od:accounts'. Resolves to the selected ids. */
    async function changed() {
      const list = await reload();
      try { storage.setItem(CHANGED_KEY, String(Date.now())); } catch (_) { /* other tabs catch up on load */ }
      const now = selected(list);
      emit(now);
      return now;
    }

    if (target && target.addEventListener) {
      target.addEventListener('storage', (e) => {
        if (e.key === CHANGED_KEY) {
          reload().then((list) => emit(selected(list)), () => { /* next load retries */ });
          return;
        }
        if (e.key !== KEY && e.key !== null) return;  // null: storage cleared in another tab
        emit(cache ? selected(cache) : null);
      });
    }

    const api = { KEY, CHANGED_KEY, EVENT, load, reload, changed, selected, setSelected, query };
    api.picker = (container) => picker(api, doc, target, container);
    return api;
  }

  // ------------------------------------------------------------ picker (DOM)

  const STYLE_ID = 'od-accounts-style';
  const CSS = `
.od-acc{position:relative;display:inline-block;font:inherit}
.od-acc-btn{font:inherit;font-size:12px;color:var(--text);background:var(--panel-2);border:1px solid var(--line-2);
  border-radius:var(--radius-sm);padding:4px 10px;cursor:pointer;white-space:nowrap}
.od-acc-btn:hover{border-color:var(--muted)}
.od-acc-btn:focus-visible{outline:none;box-shadow:var(--ring)}
.od-acc-btn:disabled{color:var(--faint);cursor:default}
.od-acc-pop{position:absolute;z-index:50;top:calc(100% + 4px);left:0;min-width:180px;max-height:320px;overflow:auto;
  background:var(--panel);border:1px solid var(--line-2);border-radius:var(--radius-sm);box-shadow:var(--shadow-pop);padding:4px}
.od-acc-pop[hidden]{display:none}
.od-acc-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:13px;color:var(--text)}
.od-acc-row:hover{background:var(--chart-hover)}
.od-acc-row input{accent-color:var(--accent);margin:0}
.od-acc-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-acc-type{color:var(--muted);font-size:11px}`;

  function addStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Renders the picker into `container`. Resolves to { refresh(), destroy() }. */
  async function picker(store, doc, target, container) {
    if (!doc || !container) throw new Error('ODAccounts.picker needs a container element');
    addStyle(doc);
    const wrap = el(doc, 'div', 'od-acc');
    const btn = el(doc, 'button', 'od-acc-btn', 'Accounts: …');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    const pop = el(doc, 'div', 'od-acc-pop');
    pop.setAttribute('role', 'group');
    pop.setAttribute('aria-label', 'Accounts to include');
    pop.hidden = true;
    wrap.append(btn, pop);
    container.appendChild(wrap);
    let list = [];

    function close() {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }

    function row(account, chosen) {
      const label = el(doc, 'label', 'od-acc-row');
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = chosen.includes(account.id);
      box.disabled = box.checked && chosen.length === 1;  // at least one stays selected
      box.addEventListener('change', () => {
        const next = box.checked ? [...chosen, account.id] : chosen.filter((id) => id !== account.id);
        if (next.length) store.setSelected(next);
        else box.checked = true;
      });
      label.append(box, el(doc, 'span', 'od-acc-name', account.name),
        el(doc, 'span', 'od-acc-type', TYPE_LABEL[account.type] || account.type));
      return label;
    }

    function render() {
      const chosen = store.selected(list);
      btn.textContent = labelFor(list, chosen);
      btn.title = list.filter((a) => chosen.includes(a.id)).map((a) => a.name).join(', ');
      pop.replaceChildren(...list.map((a) => row(a, chosen)));
    }

    const onButton = () => {
      if (pop.hidden) {
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      } else close();
    };
    const onOutside = (e) => { if (!pop.hidden && !wrap.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); }
    };
    // The list may have been reloaded (ODAccounts.changed): read the store's current one.
    const onChange = () => {
      store.load().then((fresh) => { list = fresh; render(); }, () => render());
    };
    btn.addEventListener('click', onButton);
    doc.addEventListener('mousedown', onOutside);
    doc.addEventListener('keydown', onKey);
    target.addEventListener(EVENT, onChange);

    async function refresh(fresh) {
      try {
        list = await (fresh ? store.reload() : store.load());
        btn.disabled = false;
        render();
      } catch (_) {
        list = [];
        btn.textContent = 'Accounts: unavailable';
        btn.disabled = true;
        close();
      }
    }

    await refresh(false);
    return {
      refresh: () => refresh(true),
      destroy() {
        doc.removeEventListener('mousedown', onOutside);
        doc.removeEventListener('keydown', onKey);
        target.removeEventListener(EVENT, onChange);
        wrap.remove();
      },
    };
  }

  // ------------------------------------------------------------ browser wiring

  async function fetchData(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !body || !body.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body.data;
  }

  function browser(root) {
    let storage = null;
    try { storage = root.localStorage; } catch (_) { /* blocked: the choice is not remembered */ }
    return createAccounts({ fetchJson: fetchData, storage, target: root, doc: root.document });
  }

  return { KEY, CHANGED_KEY, EVENT, selectedFrom, excludedFrom, queryFor, labelFor, readExcluded, writeExcluded,
    createAccounts, browser };
});
