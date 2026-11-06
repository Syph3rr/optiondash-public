// Home widget "Portfolio": cash and open positions summed over the selected accounts, each
// account from its one source (Portfolio.gather: TWS or the saved snapshot for IBKR, the CSV for
// Other/csv, the open journal trades for Paper and journal-sourced accounts).
(function () {
  'use strict';
  const money = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  // ---- account cash (pure; the same few lines live in page.js so each file loads on its own)
  const NO_FIGURE = '—'; // a figure TWS did not send is "no data", never $0
  const REASONS = { offline: 'not connected to TWS', failed: 'unavailable', empty: 'TWS sent no cash figures' };

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

  /** Account state from saved account rows: a missing figure reads "not saved", not "TWS sent none". */
  function savedAccountState(accounts) {
    const summary = Portfolio.accountSummary(accounts);
    return summary ? { summary, reason: '', missing: 'not saved' } : { summary: null, reason: 'not saved' };
  }

  const NOTE_MAX = 3; // accounts named in the note before "+N more"

  /** "IBKR: TWS live · Paper: Journal": where each shown account's figures come from. */
  function sourcesNote(shown) {
    const list = Array.isArray(shown) ? shown : [];
    const named = list.slice(0, NOTE_MAX).map((v) => `${v.account.name}: ${v.sourceLabel}`);
    return named.concat(list.length > NOTE_MAX ? [`+${list.length - NOTE_MAX} more`] : []).join(' · ');
  }

  if (typeof module !== 'undefined' && module.exports) { // Node tests
    module.exports = { fmtMoney, accountState, accountTiles, savedAccountState, sourcesNote };
  }
  if (typeof ODWidgets === 'undefined') return;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const kpi = (k, v, s, title) => {
    const d = el('div', 'wd-kpi');
    const val = el('div', 'v', v);
    if (title) val.title = title;
    d.append(el('div', 'k', k), val, el('div', 's', s));
    return d;
  };

  async function request(url) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      return { status: 0, body: null };
    }
  }

  /** The accounts and the selected ids: ODAccounts when Home loaded it, else every account. */
  async function accountsAndSelection() {
    const A = window.ODAccounts;
    if (A) {
      const accounts = await A.load();
      return { accounts, selected: A.selected(accounts) };
    }
    const reply = await request('/api/journal/accounts');
    if (!(reply.status === 200 && reply.body && reply.body.ok)) throw new Error((reply.body && reply.body.error) || 'accounts unavailable');
    return { accounts: reply.body.data, selected: reply.body.data.map((a) => a.id) };
  }

  // A compact summary of cash and positions. Greeks and live P&L are priced on the Portfolio page
  // (Load Greeks), not here: pricing asks TWS for quotes per underlying, and Home never polls.
  // Reads are sequential where TWS is involved (gather reads positions, then cash): the sidecar
  // answers one account read at a time. `accounts: true`: Home re-mounts it when the filter changes.
  ODWidgets.register({
    id: 'portfolio-snapshot', title: 'Portfolio', size: 1, order: 51, link: '/portfolio', accounts: true,
    async mount(box) {
      const { accounts, selected } = await accountsAndSelection();
      const data = await Portfolio.gather({ accounts, selected, request });
      const totals = Portfolio.totalsOf(data.shown);
      const s = totals.summary;
      const nothing = data.shown.every((v) => v.source === 'none' || !v.rows.length);
      if (nothing && data.tws.state === 'offline' && data.shown.every((v) => v.source === 'none' || v.source === 'journal')) {
        const idle = el('div', 'wd-idle');
        idle.append(el('strong', '', 'No positions to show'),
          el('span', 'wd-muted', 'TWS is not connected and nothing is saved. Connect in Settings, or upload a CSV on the Portfolio page.'));
        box.replaceChildren(idle);
        return;
      }
      const [cash, netLiq] = accountTiles(Portfolio.cashState(data, totals.cash));
      const g = el('div', 'wd-kpis two');
      g.append(kpi(cash.k, cash.v, cash.s, cash.title), kpi(netLiq.k, netLiq.v, netLiq.s, netLiq.title),
        kpi('Positions', String(s.totals.positions), `${s.byUnderlying.length} underlying${s.byUnderlying.length === 1 ? '' : 's'}`),
        kpi('Net cost', money(s.totals.net), 'paid (+) / received (-)'));
      const notes = [sourcesNote(data.shown)];
      if (data.journalError) notes.push(`journal: ${data.journalError}`);
      if (data.tws.state === 'failed') notes.push(`TWS: ${data.tws.error}`);
      box.replaceChildren(g, el('div', 'wd-muted', notes.filter(Boolean).join(' · ')));
    },
  });
})();
