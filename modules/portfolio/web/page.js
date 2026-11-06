// Portfolio page: the selected accounts (ODAccounts picker in the header), each with its one
// source of positions (Portfolio.gather), grouped by journal trade (grouping.js, sections.js).
// Reads on load, on Refresh, when the account filter or the connection changes; it never polls
// and never connects by itself. After a successful TWS read every IBKR account's rows are saved
// as its snapshot. Server text only reaches textContent.
(function () {
  'use strict';

  // ---- account cash (pure; the same few lines live in widgets.js so each file loads on its own)
  const NO_FIGURE = '—'; // a figure TWS did not send is "no data", never $0
  const REASONS = { offline: 'not connected to TWS', failed: 'unavailable', empty: 'TWS sent no cash figures',
    unsaved: 'not saved' };

  /** Whole units for the tile, exact figure with cents for the tooltip. USD gets "$", others a code suffix. */
  function fmtMoney(v, currency, cents) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return NO_FIGURE;
    const digits = cents ? 2 : 0;
    const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const sign = v < 0 && Number(n.replace(/,/g, '')) !== 0 ? '-' : '';
    return !currency || currency === 'USD' ? `${sign}$${n}` : `${sign}${n} ${currency}`;
  }

  /** Turn an /api/broker/account reply into { summary, reason } (reason only when there is no summary). */
  function accountState(status, body) {
    if (status === 409) return { summary: null, reason: REASONS.offline };
    if (!(status >= 200 && status < 300)) return { summary: null, reason: REASONS.failed };
    const summary = Portfolio.accountSummary(body && body.accounts);
    return summary ? { summary, reason: '' } : { summary: null, reason: REASONS.empty };
  }

  /** The account state from a saved snapshot's account rows. */
  function savedAccountState(accounts) {
    const summary = Portfolio.accountSummary(accounts);
    return summary ? { summary, reason: '', missing: REASONS.unsaved } : { summary: null, reason: REASONS.unsaved };
  }

  /** The four account tiles as plain data: label, value, exact-value tooltip, sub line. */
  function accountTiles(state) {
    const s = state.summary;
    const other = s && s.otherCurrencies.length ? `also ${s.otherCurrencies.join(', ')}, not shown` : '';
    const defs = [['Cash', 'cash', other || 'cash balance'], ['Net liquidation', 'netLiquidation', 'total account value'],
      ['Available funds', 'availableFunds', 'free to trade'], ['Buying power', 'buyingPower', 'incl. margin']];
    return defs.map(([k, key, sub]) => {
      const v = s ? s[key] : null;
      const known = typeof v === 'number';
      return { k, v: fmtMoney(v, s && s.currency), title: known ? fmtMoney(v, s.currency, true) : '',
        s: s ? (known ? sub : state.missing || REASONS.empty) : state.reason };
    });
  }

  if (typeof document === 'undefined') { // Node tests: only the pure part above
    if (typeof module !== 'undefined' && module.exports) module.exports = { fmtMoney, accountState, savedAccountState, accountTiles };
    return;
  }

  const $ = (sel) => document.querySelector(sel);
  const { el, money, costSign, cell, num, empty, greeksText } = window.PortfolioSections.dom;
  const Groups = window.PortfolioGroups;
  const Accounts = window.ODAccounts;

  // ---------------------------------------------------------------- tiles and breakdown

  function tile(k, v, sub, title) {
    const d = el('div', 'stat');
    const val = el('div', 'v', v);
    if (title) val.title = title;
    d.append(el('div', 'k', k), val, el('div', 's', sub));
    return d;
  }

  function renderTiles(s, cash) {
    $('#tiles').replaceChildren(
      tile('Positions', String(s.totals.positions), 'open legs'),
      tile('Underlyings', String(s.byUnderlying.length), 'distinct symbols'),
      tile('Net cost', money(s.totals.net), '+ paid, - received'),
      tile('Gross cost', money(s.totals.gross), 'absolute, all legs'),
      ...accountTiles(cash).map((t) => tile(t.k, t.v, t.s, t.title)));
  }

  function table(headers, rows) {
    const t = el('table', 't');
    const head = el('thead');
    const tr = el('tr');
    headers.forEach(([label, right]) => tr.append(el('th', right ? 'r' : '', label)));
    head.append(tr);
    const body = el('tbody');
    rows.forEach((cells) => { const r = el('tr'); r.append(...cells); body.append(r); });
    t.append(head, body);
    return t;
  }

  const barCell = (share) => {
    const td = el('td', 'pf-bartd');
    const b = el('span', 'pf-bar');
    b.style.width = `${Math.max(2, Math.round(share * 100))}%`;
    td.append(b);
    return td;
  };

  function renderBreakdown(s) {
    const top = Math.max(1, ...s.byUnderlying.map((r) => r.gross));
    $('#by-underlying').replaceChildren(s.byUnderlying.length ? table(
      [['Symbol'], ['Legs', 1], ['Shares', 1], ['Net cost', 1], ['Gross', 1], ['']],
      s.byUnderlying.map((r) => [cell(r.symbol), num(String(r.legs)), num(String(r.shares || '')),
        num(money(r.net), costSign(r.net)), num(money(r.gross)), barCell(r.gross / top)])) : empty('No positions.'));
    const topE = Math.max(1, ...s.byExpiry.map((r) => r.gross));
    $('#by-expiry').replaceChildren(s.byExpiry.length ? table(
      [['Expiry'], ['Legs', 1], ['Net cost', 1], ['Gross', 1], ['']],
      s.byExpiry.map((r) => [cell(r.expiry), num(String(r.legs)), num(money(r.net), costSign(r.net)),
        num(money(r.gross)), barCell(r.gross / topE)])) : empty('No option positions.'));
  }

  /** The banner under the header (errors and the TWS-off note). */
  function message(text, isError) {
    const m = $('#message');
    m.hidden = !text;
    $('#message-text').textContent = text || '';
    m.className = `card pf-msg${isError ? ' err' : ''}`;
  }

  // ---------------------------------------------------------------- state and drawing

  let views = [];         // accountRows() results with `grouped`, as last read
  let live = null;        // Load Greeks results for `views`, or null
  let greeksSeq = 0;      // bumped on every re-read so stale pricing is dropped

  function draw() {
    window.PortfolioSections.render($('#accounts'), views, { live, onUpload: (id) => drawer.open(id) });
    $('#load-greeks').disabled = !views.some((v) => v.grouped.groups.some((g) => g.rows.length) || v.grouped.unmatched.length);
  }

  function resetGreeks() {
    greeksSeq += 1;
    live = null;
    $('#greeks-total').textContent = 'Load Greeks prices each underlying once, on request.';
    $('#greeks-notes').hidden = true;
  }

  async function loadGreeks() {
    const mine = ++greeksSeq;
    const btn = $('#load-greeks');
    btn.disabled = true;
    $('#greeks-total').textContent = 'Pricing…';
    $('#greeks-notes').hidden = true;
    try {
      const out = await window.PortfolioGreeks.price(views, (parseFloat($('#rate').value) || 0) / 100,
        (parseFloat($('#divy').value) || 0) / 100);
      if (mine !== greeksSeq) return; // positions changed while pricing: these results are stale
      live = out.live;
      const g = greeksText(out.total.greeks);
      const pnl = out.total.pnl === null ? '' : `Unrealised ${money(out.total.pnl)}`;
      $('#greeks-total').textContent = [g ? `Total ${g}` : 'Nothing could be priced.', pnl].filter(Boolean).join(' · ');
      $('#greeks-notes').hidden = !out.notes.length;
      $('#greeks-notes').textContent = out.notes.join(' ');
      draw();
    } catch (e) {
      if (mine === greeksSeq) $('#greeks-total').textContent = `Could not price: ${e.message}`;
    } finally {
      draw();
    }
  }

  // ---------------------------------------------------------------- reading

  async function request(url) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      return { status: 0, body: { error: 'OptionDash is not reachable' } };
    }
  }

  /** Keep the last good TWS read, per IBKR account. A failure only costs the saved copy. */
  async function saveTwsRead(accounts, tws) {
    const failed = [];
    for (const save of Portfolio.twsSaves(accounts, tws.positions, tws.cash)) {
      const body = save.accounts ? { positions: save.positions, accounts: save.accounts } : { positions: save.positions };
      const res = await fetch(`/api/journal/accounts/${save.id}/snapshot/tws`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
        .catch(() => null);
      if (!res || !res.ok) failed.push(save.id);
    }
    if (failed.length) message('Could not save this TWS read for every IBKR account; the saved copies are older.', true);
  }

  function banner(data) {
    if (data.journalError) return message(`Journal unavailable: ${data.journalError}`, true);
    if (data.tws.state === 'failed') return message(`TWS read failed: ${data.tws.error}`, true);
    if (data.tws.state === 'offline') return message('TWS is not connected: IBKR accounts show their saved positions.', false);
    return message('', false);
  }

  let inflight = false;
  let again = false;
  async function load() {
    if (inflight) { again = true; return; }
    inflight = true;
    $('#refresh').disabled = true;
    try {
      const accounts = await Accounts.reload();
      drawer.setAccounts(accounts);
      const data = await Portfolio.gather({ accounts, selected: Accounts.selected(accounts), request });
      resetGreeks();
      views = data.shown.map((v) => ({ ...v, grouped: v.source === 'none' ? { groups: [], unmatched: [] }
        : Groups.groupByTrade({ rows: v.rows, trades: v.trades, brokerSourced: v.brokerSourced }) }));
      const totals = Portfolio.totalsOf(data.shown);
      renderTiles(totals.summary, Portfolio.cashState(data, totals.cash));
      renderBreakdown(totals.summary);
      banner(data);
      $('#asof').textContent = data.tws.state === 'live' && data.tws.asOf ? `TWS as of ${data.tws.asOf}` : '';
      draw();
      if (data.tws.state === 'live') await saveTwsRead(accounts, data.tws);
    } catch (e) {
      message(`Cannot load the portfolio: ${e.message}`, true);
    } finally {
      inflight = false;
      $('#refresh').disabled = false;
      if (again) { again = false; load(); }
    }
  }

  // ---------------------------------------------------------------- wiring

  const drawer = window.PortfolioDrawer.mount({ onChanged: load });
  const defaults = window.ODPrefs ? window.ODPrefs.get() : null; // Settings' pricing defaults
  if (defaults) {
    $('#rate').value = String(defaults.rate);
    $('#divy').value = String(defaults.divYield);
  }
  let picker = null;
  Accounts.picker($('#account-picker')).then((p) => { picker = p; }, () => {});
  $('#refresh').addEventListener('click', () => { if (picker) picker.refresh(); load(); });
  $('#load-greeks').addEventListener('click', loadGreeks);
  $('#open-saved').addEventListener('click', () => drawer.open());
  window.addEventListener(Accounts.EVENT, () => load());
  window.addEventListener('broker:changed', (e) => {
    if (!(e.detail && e.detail.source === 'portfolio')) load();
  });
  load();
})();
