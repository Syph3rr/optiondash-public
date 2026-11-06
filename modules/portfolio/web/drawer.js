// Portfolio page: the Saved positions drawer (a modal <dialog>). Upload a CSV, change the cash
// figures or clear the snapshot of one account that takes a CSV (an IBKR account, or an Other
// account whose source is csv). Talks to /api/journal/accounts/{id}/snapshot only.
(function () {
  'use strict';
  const P = window.Portfolio;
  const $ = (sel) => document.querySelector(sel);
  const MAX_CSV_BYTES = 256000; // the journal's limit
  const CASH_FIELDS = ['currency', 'cash', 'net_liquidation', 'available_funds', 'buying_power'];

  /** Accounts a CSV can be uploaded to, in list order. */
  const takesCsv = (a) => a.type === 'ibkr' || (a.type === 'other' && a.source === 'csv');

  /** The journal's {ok, data, error} envelope: data, or an Error carrying the message. */
  async function journal(path, init) {
    const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init && init.headers) } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.ok) throw new Error((body && body.error) || `request failed (${res.status})`);
    return body.data;
  }
  const sendJson = (method, path, data) =>
    journal(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const snapshotUrl = (id) => `/api/journal/accounts/${id}/snapshot`;

  /**
   * @param {{onChanged: function()}} opts onChanged runs after an upload or a clear
   * @returns {{open(accountId?: number), setAccounts(accounts: object[]), save: function}}
   */
  function mount(opts) {
    const drawer = $('#saved');
    const select = $('#saved-account');
    let choices = [];
    let readSeq = 0;

    function status(text, errors) {
      $('#csv-status').textContent = text || '';
      $('#csv-errors').hidden = !errors;
      $('#csv-errors').textContent = errors || '';
    }

    function showSnapshot(snap) {
      $('#saved-note').textContent = snap
        ? `${P.snapshotSource(snap)}, saved ${P.savedWhen(snap.saved_at)} · ${snap.positions.length} position(s)`
        : 'nothing saved yet';
      Object.entries(P.cashForm(snap ? snap.accounts : [])).forEach(([k, v]) => { $(`#cash-${k}`).value = v; });
    }

    const chosen = () => Number(select.value);

    async function readChosen() {
      const mine = ++readSeq;
      if (!choices.length) { showSnapshot(null); return; }
      $('#saved-note').textContent = 'Reading…';
      try {
        const snap = await journal(snapshotUrl(chosen()));
        if (mine === readSeq) showSnapshot(snap);
      } catch (e) {
        if (mine === readSeq) $('#saved-note').textContent = `Could not read the saved positions: ${e.message}`;
      }
    }

    function setAccounts(accounts) {
      const keep = chosen();
      choices = (Array.isArray(accounts) ? accounts : []).filter(takesCsv);
      select.replaceChildren(...choices.map((a) => {
        const o = document.createElement('option');
        o.value = String(a.id);
        o.textContent = a.name;
        return o;
      }));
      if (choices.some((a) => a.id === keep)) select.value = String(keep);
      const none = !choices.length;
      ['#csv-save', '#csv-clear', '#csv-file'].forEach((s) => { $(s).disabled = none; });
      select.disabled = none;
      if (none) $('#saved-note').textContent = 'No account takes a CSV. Add an IBKR account, or an Other account with a CSV source, in Settings.';
    }

    function open(accountId) {
      if (choices.some((a) => a.id === accountId)) select.value = String(accountId);
      status('');
      if (choices.length) readChosen();
      if (!drawer.open) drawer.showModal();
    }

    function downloadTemplate() {
      const url = URL.createObjectURL(new Blob([P.TEMPLATE_CSV], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'optiondash-positions.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    async function save() {
      const file = $('#csv-file').files[0];
      if (!file) { status('', 'Choose a CSV file first (Download template shows the format).'); return; }
      if (file.size > MAX_CSV_BYTES) { status('', 'That file is too large (over 250 KB).'); return; }
      const cash = P.cashBody(Object.fromEntries(CASH_FIELDS.map((k) => [k, $(`#cash-${k}`).value])));
      if (cash.error) { status('', cash.error); return; }
      $('#csv-save').disabled = true;
      status('Saving…');
      try {
        const snap = await sendJson('POST', `${snapshotUrl(chosen())}/csv`, { csv: await file.text(), cash: cash.body });
        status(`Saved ${snap.positions.length} position(s).`);
        showSnapshot(snap);
        $('#csv-file').value = '';
        drawer.close();
        opts.onChanged();
      } catch (e) {
        status('', `Nothing was saved. Fix these and upload again:\n${e.message}`);
      } finally {
        $('#csv-save').disabled = !choices.length;
      }
    }

    async function clear() {
      const account = choices.find((a) => a.id === chosen());
      if (!account || !window.confirm(`Remove the saved positions and cash of ${account.name}?`)) return;
      try {
        await journal(snapshotUrl(account.id), { method: 'DELETE' });
        status('Cleared.');
        showSnapshot(null);
        opts.onChanged();
      } catch (e) {
        status('', `Could not clear: ${e.message}`);
      }
    }

    select.addEventListener('change', () => { status(''); readChosen(); });
    $('#close-saved').addEventListener('click', () => drawer.close());
    drawer.addEventListener('click', (e) => { // the backdrop counts as the dialog itself: check the point
      const r = drawer.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === drawer && outside) drawer.close();
    });
    $('#csv-template').addEventListener('click', downloadTemplate);
    $('#csv-save').addEventListener('click', save);
    $('#csv-clear').addEventListener('click', clear);
    return { open, setAccounts };
  }

  window.PortfolioDrawer = { mount, takesCsv };
})();
