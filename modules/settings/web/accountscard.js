// Settings → Accounts: list, add, rename, edit broker ref / source, reorder and delete journal
// accounts (/api/journal/accounts). After every change ODAccounts.changed() reloads the shared
// list and fires 'od:accounts' here and in other open tabs. No window.confirm: deleting asks
// inline. Server text only reaches textContent. Pure helpers are exported for Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.SettingsAccounts = api;
    const start = () => api.mount(root.document.getElementById('accounts-card'), root);
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const URL = '/api/journal/accounts';
  const NAME_MAX = 40;
  const BROKER_REF = /^[A-Za-z0-9._-]{1,32}$/;
  const SOURCES = { ibkr: ['tws'], paper: ['journal'], other: ['csv', 'journal'] };
  const SOURCE_LABEL = { tws: 'TWS', csv: 'CSV', journal: 'Journal' };
  const TYPE_LABEL = { ibkr: 'IBKR', paper: 'Paper', other: 'Other' };
  const BROKER_HINT = 'IBKR account number, e.g. U1234567; used to file imported fills';

  // ------------------------------------------------------------ pure logic

  const sourceChoices = (type) => [...(SOURCES[type] || [])];
  const sourceLabel = (source) => SOURCE_LABEL[source] || String(source);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function countsLabel(a) {
    return a.trades ? `${a.open_trades} open · ${plural(a.trades, 'trade')}` : 'No trades';
  }

  /** '' when fine, else what is wrong with the name. `exceptId`: the account being renamed. */
  function checkName(raw, accounts, exceptId) {
    const name = String(raw || '').trim();
    if (!name) return 'Give the account a name.';
    if (name.length > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`;
    const clash = (accounts || []).find((a) => a.id !== exceptId && a.name.toLowerCase() === name.toLowerCase());
    return clash ? `There is already an account called ${clash.name}.` : '';
  }

  /** Blank is null (no broker ref); otherwise upper-cased and checked like the server does. */
  function normaliseBrokerRef(raw) {
    const v = String(raw || '').trim();
    if (!v) return { value: null, error: '' };
    if (!BROKER_REF.test(v)) {
      return { value: null, error: 'Broker ref: up to 32 letters, digits, dots, dashes or underscores.' };
    }
    return { value: v.toUpperCase(), error: '' };
  }

  /** The sort_order updates that move account `id` one place (dir -1 up, +1 down), as listed. */
  function reorderPlan(accounts, id, dir) {
    const list = [...(accounts || [])];
    const i = list.findIndex((a) => a.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return [];
    const order = list.map((a, k) => (k === i ? list[j] : k === j ? list[i] : a));
    return order.map((a, k) => ({ id: a.id, sort_order: k })).filter((u) => {
      const was = list.find((a) => a.id === u.id);
      return was.sort_order !== u.sort_order;
    });
  }

  const moveTargets = (accounts, id) => (accounts || []).filter((a) => a.id !== id);

  function deleteQuestion(a) {
    return a.trades ? `Move its ${plural(a.trades, 'trade')} to` : `Delete ${a.name}?`;
  }

  // ------------------------------------------------------------ DOM

  function el(doc, tag, props, ...children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
    return node;
  }

  async function call(method, url, body) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch(url, init); } catch (_) { throw new Error('The journal server is not reachable.'); }
    const reply = await res.json().catch(() => null);
    if (!res.ok || !reply || reply.ok === false) {
      const msg = reply && (reply.error || (typeof reply.detail === 'string' && reply.detail));
      throw new Error(msg || `Request failed (HTTP ${res.status})`);
    }
    return reply.data;
  }

  function mount(card, win) {
    if (!card) return null;
    const doc = win.document;
    const store = win.ODAccounts;
    const h = (...args) => el(doc, ...args);
    const listBox = card.querySelector('[data-accounts-list]');
    const addBox = card.querySelector('[data-accounts-add]');
    const addBtn = card.querySelector('[data-accounts-open-add]');
    const errBox = card.querySelector('[data-accounts-error]');
    let accounts = [];
    let busy = false;

    function showError(message) {
      errBox.textContent = message || '';
      errBox.hidden = !message;
    }

    /** Runs one change, then reloads the shared list (other pages and tabs follow). */
    async function change(fn) {
      if (busy) return false;
      busy = true;
      showError('');
      try {
        await fn();
        return true;
      } catch (err) {
        showError(err.message || String(err));
        return false;
      } finally {
        try {
          await store.changed();
          accounts = await store.load();
        } catch (err) {
          showError(err.message || String(err));
        }
        busy = false;
        render();
      }
    }

    const put = (id, body) => call('PUT', `${URL}/${id}`, body);

    // ---- one account row
    function nameCell(a) {
      const input = h('input', { type: 'text', value: a.name, maxlength: String(NAME_MAX), 'aria-label': `Name of ${a.name}`, class: 'acc-name-in' });
      const save = async () => {
        const name = input.value.trim();
        if (name === a.name) return;
        const bad = checkName(name, accounts, a.id);
        if (bad) { showError(bad); input.value = a.name; return; }
        await change(() => put(a.id, { name }));
      };
      input.addEventListener('change', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = a.name; input.blur(); }
      });
      return input;
    }

    function sourceCell(a) {
      const choices = sourceChoices(a.type);
      if (choices.length < 2) return h('span', { class: 'acc-src' }, sourceLabel(a.source));
      const select = h('select', { 'aria-label': `Source of ${a.name}` },
        choices.map((s) => h('option', { value: s, selected: s === a.source }, sourceLabel(s))));
      select.addEventListener('change', () => change(() => put(a.id, { source: select.value })));
      return select;
    }

    function brokerCell(a) {
      if (a.type !== 'ibkr') return null;
      const input = h('input', { type: 'text', value: a.broker_ref || '', placeholder: 'broker ref', maxlength: '32',
        class: 'acc-ref', title: BROKER_HINT, 'aria-label': `Broker ref of ${a.name}` });
      input.addEventListener('change', () => {
        const ref = normaliseBrokerRef(input.value);
        if (ref.error) { showError(ref.error); input.value = a.broker_ref || ''; return; }
        if (ref.value === (a.broker_ref || null)) return;
        change(() => put(a.id, { broker_ref: ref.value }));
      });
      return input;
    }

    function moveButtons(a, i) {
      const move = (dir) => change(async () => {
        for (const u of reorderPlan(accounts, a.id, dir)) await put(u.id, { sort_order: u.sort_order });
      });
      return h('span', { class: 'acc-order' },
        h('button', { type: 'button', class: 'iconbtn', title: 'Move up', 'aria-label': `Move ${a.name} up`,
          disabled: i === 0, onclick: () => move(-1) }, '↑'),
        h('button', { type: 'button', class: 'iconbtn', title: 'Move down', 'aria-label': `Move ${a.name} down`,
          disabled: i === accounts.length - 1, onclick: () => move(1) }, '↓'));
    }

    function deleteArea(a, row) {
      const btn = h('button', { type: 'button', class: 'btn sm danger', disabled: accounts.length < 2,
        title: accounts.length < 2 ? 'The last account cannot be deleted' : '' }, 'Delete');
      const area = h('span', { class: 'acc-del' }, btn);
      btn.addEventListener('click', () => {
        const no = h('button', { type: 'button', class: 'btn sm' }, 'No');
        const yes = h('button', { type: 'button', class: 'btn sm danger' }, a.trades ? 'Move and delete' : 'Yes');
        let target = null;
        if (a.trades) {
          target = h('select', { 'aria-label': 'Account to move the trades to' },
            moveTargets(accounts, a.id).map((t) => h('option', { value: String(t.id) }, t.name)));
        }
        no.addEventListener('click', () => area.replaceChildren(btn));
        yes.addEventListener('click', () => change(() => call('DELETE',
          target ? `${URL}/${a.id}?move_to=${encodeURIComponent(target.value)}` : `${URL}/${a.id}`)));
        area.replaceChildren(h('span', { class: 'acc-ask' }, deleteQuestion(a)),
          target, target ? h('span', { class: 'acc-ask' }, 'and delete?') : null, yes, no);
        row.classList.add('asking');
        (target || no).focus();
      });
      return area;
    }

    function row(a, i) {
      const tr = h('div', { class: 'acc-row', 'data-account': String(a.id) });
      // Native append() would print a missing cell (brokerCell is null off IBKR) as "null".
      tr.append(...[moveButtons(a, i), nameCell(a),
        h('span', { class: `acc-type ${a.type}` }, TYPE_LABEL[a.type] || a.type),
        sourceCell(a), brokerCell(a), h('span', { class: 'grow' }),
        h('span', { class: 'acc-count' }, countsLabel(a)), deleteArea(a, tr)].filter(Boolean));
      return tr;
    }

    function render() {
      listBox.replaceChildren(...(accounts.length ? accounts.map(row)
        : [h('p', { class: 'st-note' }, 'No accounts loaded.')]));
    }

    // ---- add form
    function addForm() {
      const name = h('input', { type: 'text', maxlength: String(NAME_MAX), placeholder: 'e.g. Roth IRA', 'aria-label': 'New account name' });
      const type = h('select', { 'aria-label': 'Type' },
        Object.entries(TYPE_LABEL).map(([v, label]) => h('option', { value: v }, label)));
      const source = h('select', { 'aria-label': 'Source' },
        sourceChoices('other').map((s) => h('option', { value: s }, sourceLabel(s))));
      const ref = h('input', { type: 'text', maxlength: '32', placeholder: 'U1234567 (optional)', 'aria-label': 'Broker ref' });
      const sourceField = h('label', { class: 'acc-field' }, 'Source', source);
      const refField = h('label', { class: 'acc-field' }, 'Broker ref', ref, h('span', { class: 'st-hint' }, BROKER_HINT));
      const paint = () => {
        sourceField.hidden = type.value !== 'other';
        refField.hidden = type.value !== 'ibkr';
      };
      type.addEventListener('change', paint);
      const save = h('button', { type: 'button', class: 'btn primary sm' }, 'Add');
      const cancel = h('button', { type: 'button', class: 'btn sm' }, 'Cancel');
      const close = () => { addBox.hidden = true; addBox.replaceChildren(); addBtn.hidden = false; };
      cancel.addEventListener('click', close);
      const submit = async () => {
        const bad = checkName(name.value, accounts);
        if (bad) { showError(bad); name.focus(); return; }
        const body = { name: name.value.trim(), type: type.value };
        if (type.value === 'other') body.source = source.value;
        if (type.value === 'ibkr') {
          const r = normaliseBrokerRef(ref.value);
          if (r.error) { showError(r.error); ref.focus(); return; }
          if (r.value) body.broker_ref = r.value;
        }
        if (await change(() => call('POST', URL, body))) close();
      };
      save.addEventListener('click', submit);
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      paint();
      addBox.replaceChildren(h('label', { class: 'acc-field' }, 'Name', name), h('label', { class: 'acc-field' }, 'Type', type),
        sourceField, refField, h('span', { class: 'acc-add-actions' }, save, cancel));
      addBox.hidden = false;
      addBtn.hidden = true;
      name.focus();
    }

    addBtn.addEventListener('click', addForm);
    // Changes made elsewhere (another tab) arrive as od:accounts: show the current list.
    win.addEventListener(store.EVENT, () => {
      if (busy) return;
      store.load().then((list) => { accounts = list; render(); }, () => {});
    });

    store.load().then((list) => { accounts = list; render(); },
      (err) => showError(`Accounts are unavailable: ${err.message || err}`));
    return { render };
  }

  return { sourceChoices, sourceLabel, countsLabel, checkName, normaliseBrokerRef, reorderPlan,
    moveTargets, deleteQuestion, mount };
});
