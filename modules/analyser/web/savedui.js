// Saved analyses bar: a list of saved set-ups with Load, Save (overwrite or as new) and delete.
// DOM only; the state blob and API live in savedanalyses.js. Built with DOM calls and
// textContent, never HTML strings, because names come back from the server.
//
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("savedui.js", JS, "../modules/analyser/web/savedui.js"),
(function () {
  'use strict';
  const OD = window.OptionDash, A = window.ODSaved;
  if (!OD || !A) return;
  const S = OD.S;
  const HOLD_MS = 6000;
  const HEADER_FIELDS = ['symbol', 'spot', 'model', 'rate', 'divy', 'pdte'];
  const api = A.api((path, init) => window.fetch(path, init));
  const $ = (id) => document.getElementById(id);
  const ui = {};
  let rows = [];
  let active = null;     // {id, name} of the analysis last loaded or saved
  let busy = false;

  function el(tag, props, ...kids) {
    const n = Object.assign(document.createElement(tag), props || {});
    kids.forEach((k) => n.append(k));
    return n;
  }
  const button = (text, onclick, extra = {}) => el('button', { className: 'btn', type: 'button', textContent: text, onclick, ...extra });
  const say = (msg, err = false) => OD.setStatus(msg, err, HOLD_MS);

  // ---------------------------------------------------------------- list
  const selectedId = () => (ui.list.value ? +ui.list.value : null);
  const selectedRow = () => rows.find((r) => r.id === selectedId()) || null;

  function renderList(keepId) {
    const blank = el('option', { value: '', textContent: rows.length ? '— saved analyses —' : '— none saved yet —' });
    ui.list.replaceChildren(blank, ...rows.map((r) => el('option', { value: String(r.id), textContent: A.optionText(r) })));
    ui.list.value = rows.some((r) => r.id === keepId) ? String(keepId) : '';
    renderButtons();
  }

  function renderButtons() {
    const none = !selectedId();
    ui.load.disabled = busy || none;
    ui.del.disabled = busy || none;
    ui.save.disabled = busy;
    ui.active.textContent = active ? `Loaded: ${active.name}` : '';
    ui.active.title = active ? active.name : '';
  }

  async function refreshList(keepId) {
    try {
      rows = await api.list();
      ui.note.textContent = '';
    } catch (e) {
      rows = [];
      ui.note.textContent = `Saved analyses unavailable: ${e.message}`;
    }
    renderList(keepId);
  }

  async function guarded(work) {
    if (busy) return;
    busy = true;
    renderButtons();
    try { await work(); } catch (e) { say(e.message, true); } finally { busy = false; renderButtons(); }
  }

  // ---------------------------------------------------------------- load
  function syncControls() {
    HEADER_FIELDS.forEach((f) => { const input = $(f); if (input && S[f] != null) input.value = S[f]; });
    ['ivshift', 'ivbox'].forEach((id) => { const input = $(id); if (input) input.value = S.ivShift; });
    const live = $('mktlive');
    if (live) live.checked = false;
  }

  /** Puts a restored state into the shared analyser state. Live market data stays off: it would
   *  otherwise overwrite the saved spot with whatever symbol the feed was following. */
  function applyState(next) {
    const M = window.ODMarket;
    const legs = M ? M.ageLegs(next.legs, Date.now()) : next.legs;   // listed dates follow the calendar
    Object.assign(S, next, { legs, tPin: null, liveOn: false });
    syncControls();
    OD.showView(S.view);
    OD.legsChanged();
  }

  const loadSelected = () => guarded(async () => {
    const row = selectedRow();
    if (!row) return;
    closePrompt();
    const saved = await api.get(row.id);
    const { state, dropped } = A.restore(saved.state);
    applyState(state);
    active = { id: saved.id, name: saved.name };
    say(dropped ? `Loaded "${saved.name}"; ${dropped} damaged leg${dropped > 1 ? 's were' : ' was'} left out`
      : `Loaded "${saved.name}"`, dropped > 0);
  });

  // ---------------------------------------------------------------- save
  async function saveAs(mode) {
    const name = ui.name.value.trim();
    const problem = A.nameProblem(name);
    if (problem) { ui.promptNote.textContent = problem; ui.name.focus(); return; }
    await guarded(async () => {
      const state = A.serialise(S);
      const saved = mode === 'overwrite' && active
        ? await api.update(active.id, name, state)
        : await api.create(name, state);
      active = { id: saved.id, name: saved.name };
      closePrompt();
      await refreshList(saved.id);
      say(mode === 'overwrite' ? `Saved over "${saved.name}"` : `Saved "${saved.name}"`);
    });
  }

  function openSave() {
    closePrompt();
    ui.name.value = active ? active.name : A.suggestName(S, Date.now());
    ui.promptNote.textContent = '';
    // Save as new is the default (and Enter): overwriting must be a deliberate click.
    const actions = active
      ? [button('Save as new', () => saveAs('new'), { className: 'btn primary' }),
        button(`Overwrite "${active.name}"`, () => saveAs('overwrite'))]
      : [button('Save', () => saveAs('new'), { className: 'btn primary' })];
    ui.prompt.replaceChildren(el('label', { htmlFor: 'svname', textContent: 'Name' }), ui.name,
      ...actions, button('Cancel', closePrompt), ui.promptNote);
    ui.name.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveAs('new'); }
      if (e.key === 'Escape') closePrompt();
    };
    ui.prompt.hidden = false;
    ui.name.select();
  }

  // ---------------------------------------------------------------- delete
  const removeSelected = (row) => guarded(async () => {
    await api.remove(row.id);
    if (active && active.id === row.id) active = null;
    closePrompt();
    await refreshList(null);
    say(`Deleted "${row.name}"`);
  });

  function askDelete() {
    const row = selectedRow();
    if (!row) return;
    closePrompt();
    const yes = button('Delete', () => removeSelected(row), { className: 'btn sv-danger' });
    ui.prompt.replaceChildren(el('span', { textContent: `Delete "${row.name}"? This cannot be undone.` }),
      yes, button('Cancel', closePrompt));
    ui.prompt.hidden = false;
    yes.focus();
  }

  function closePrompt() {
    ui.prompt.hidden = true;
    ui.prompt.replaceChildren();
  }

  // ---------------------------------------------------------------- build
  const STYLE = `
    .sv-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 14px; }
    .sv-bar label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .sv-bar select, .sv-bar input { background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; height: 28px; padding: 0 6px; }
    .sv-bar select { min-width: 220px; max-width: 420px; }
    .sv-bar input { width: 240px; }
    .sv-del { width: 28px; padding: 0; }
    .sv-prompt { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-basis: 100%; font-size: 12.5px; }
    .sv-prompt[hidden] { display: none; }
    .sv-danger { color: var(--neg); border-color: var(--neg); }
    .sv-active { color: var(--faint); font-size: 12px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sv-note { color: var(--faint); font-size: 12px; }`;

  function build() {
    document.head.append(el('style', { textContent: STYLE }));
    ui.list = el('select', { id: 'svlist', onchange: renderButtons, title: 'Analyses saved in the journal database' });
    ui.load = button('Load', loadSelected, { title: 'Replace the current set-up with the selected analysis' });
    ui.del = button('×', askDelete, { className: 'btn sv-del', title: 'Delete the selected analysis', ariaLabel: 'Delete the selected analysis' });
    ui.save = button('Save', openSave, { className: 'btn primary', title: 'Save the current set-up under a name' });
    ui.active = el('span', { className: 'sv-active' });
    ui.note = el('span', { className: 'sv-note' });
    ui.name = el('input', { id: 'svname', maxLength: A.NAME_MAX, autocomplete: 'off' });
    ui.promptNote = el('span', { className: 'sv-note', role: 'alert' });
    ui.prompt = el('div', { className: 'sv-prompt', hidden: true });
    const bar = el('section', { className: 'card sv-bar', ariaLabel: 'Saved analyses' },
      el('label', { htmlFor: 'svlist', textContent: 'Saved' }), ui.list, ui.load, ui.del, ui.save, ui.active, ui.note, ui.prompt);
    const main = document.querySelector('main');
    main.insertBefore(bar, main.firstChild);
  }

  /** The set-up was replaced elsewhere (journal trade, preset): Save no longer offers Overwrite. */
  function forget() {
    if (!active) return;
    active = null;
    closePrompt();
    renderButtons();
  }

  build();
  renderList(null);
  refreshList(null);
  window.ODSavedUI = { forget };
})();
