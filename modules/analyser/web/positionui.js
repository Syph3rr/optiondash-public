// Position panel: my fills vs current prices, unrealised P&L, and where it came from since entry.
// Also the Manual / Market switch for current prices. DOM only; the maths lives in position.js.
// Built with DOM calls and textContent (no HTML strings): prices can come from market data.
//
// Nothing here connects or polls. Market prices are fetched once when the page loads in Market mode
// and again only when "Refresh prices" is pressed.
//
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("positionui.js", JS, "../modules/analyser/web/positionui.js"),
(function () {
  'use strict';
  const OD = window.OptionDash, P = window.ODPosition, K = window.ODControls;
  if (!OD || !P || !K) return;
  const S = OD.S;
  const REQUEST_MS = 20000;
  const DAYS_ROUND = 1000;          // reprice again only when days held moves by ~1.4 minutes
  const ui = {};
  const cache = { key: '', now: null, entry: null };
  let seq = 0;
  // Set on switching Manual -> Market: the next successful fetch keeps typed premiums as fills.
  let promotePending = false;

  if (!S.entry || typeof S.entry !== 'object') S.entry = { date: null, spot: null, iv: null };
  if (S.priceSource !== 'live') S.priceSource = 'manual';

  const el = (tag, props, ...kids) => {
    const n = Object.assign(document.createElement(tag), props || {});
    kids.forEach((k) => n.append(k));
    return n;
  };
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const fmt = (x, d = 2) => (num(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const signed = (x, d = 2) => (num(x) ? (x < 0 ? '−' : '+') + fmt(Math.abs(x), d) : '—');
  const money = (x) => (num(x) ? (x < 0 ? '−$' : '+$') + fmt(Math.abs(x), 0) : '—');
  const tone = (x) => (num(x) && x > 0.5 ? 'pos' : num(x) && x < -0.5 ? 'neg' : '');

  // ---------------------------------------------------------------- pricing
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_MS) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error((j && j.error) || `request failed (${r.status})`);
    return j;
  }

  function entryNow() {
    const check = P.entryCheck(S.entry, Date.now(), K);
    return check.ok ? { ...check, daysHeld: Math.round(check.daysHeld * DAYS_ROUND) / DAYS_ROUND } : check;
  }

  /** Reprices only when the bodies change: fills and prices alone need no new request. */
  async function refresh() {
    syncEntryInputs();
    if (!P.hasFills(S.legs)) { render(null); return; }
    const check = entryNow();
    const priced = P.repricingBodies(S, check);
    const key = JSON.stringify([priced.now, priced.entry]);
    if (key !== cache.key) {
      const mine = ++seq;
      try {
        const [now, entry] = await Promise.all([post('/api/analyze', priced.now),
          priced.entry ? post('/api/analyze', priced.entry) : null]);
        if (mine !== seq) return;
        Object.assign(cache, { key, now, entry });
      } catch (e) {
        if (mine !== seq) return;
        Object.assign(cache, { key: '', now: null, entry: null });
        render({ error: `Position not priced: ${e.message}` });
        return;
      }
    }
    const theos = P.theosNow(S, priced, cache.now);
    const rows = P.positionRows(S.legs, theos, S.spot);
    const attr = check.ok && cache.entry ? P.attribution(S, priced, rows, cache.entry, cache.now) : null;
    render({ rows, totals: P.totals(rows), check, attr });
  }

  // ---------------------------------------------------------------- live prices
  function setNote(text, err = false) {
    ui.liveNote.textContent = text;
    ui.liveNote.className = `legend-note pos-live-note${err ? ' err' : ''}`;
  }

  async function brokerStatus() {
    try {
      const r = await fetch('/api/broker/status', { signal: AbortSignal.timeout(REQUEST_MS) });
      return await r.json();
    } catch (e) { return { sidecar: 'offline', reason: 'server not reachable' }; }
  }

  function applyLive(data, symbol) {
    const out = P.applyQuotes(S.legs, data.quotes, symbol, { promote: promotePending });
    promotePending = false;
    S.legs.forEach((l, i) => Object.assign(l, out.legs[i]));     // the legs table holds these objects
    const spot = data.underlying && num(data.underlying.price) && data.underlying.price > 0 ? data.underlying.price : null;
    if (spot !== null) { S.spot = spot; const box = document.getElementById('spot'); if (box) box.value = spot; }
    return out;
  }

  async function refreshPrices() {
    if (ui.refresh.disabled) return;
    ui.refresh.disabled = true;
    setNote('fetching prices…');
    try {
      const status = await brokerStatus();
      if (status.sidecar !== 'online') {
        setNote(`Market prices unavailable (${status.reason || 'market data offline'}); keeping the prices typed in.`, true);
        return;
      }
      const symbol = String(S.symbol || '').trim().toUpperCase();
      const contracts = P.contractsToQuote(S.legs, symbol);
      const data = await post('/api/market/quotes', { symbol, contracts, spot: S.spot > 0 ? S.spot : null,
        rate: S.rate / 100, div_yield: S.divy / 100, model: S.model });
      const out = applyLive(data, symbol);
      OD.changed(true);
      const M = window.ODMarket;
      const sources = M && Array.isArray(data.quotes) ? M.chainSources(data.quotes).join(', ') : '';
      const when = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      const via = status.ibkr === 'connected' ? '' : ' · TWS not connected';
      const skipped = S.legs.filter((l) => l.enabled && l.kind !== 'stock' && !P.contractFor(l, symbol)).length;
      setNote(`${out.priced} price${out.priced === 1 ? '' : 's'} at ${when}${sources ? ` (${sources})` : ''}${via}`
        + (out.missed ? ` · ${out.missed} without a quote` : '')
        + (skipped ? ` · ${skipped} not on a listed contract (use Sync to market)` : '')
        + (out.promoted ? ` · ${out.promoted} typed premium${out.promoted === 1 ? '' : 's'} kept as my fill` : ''),
        out.missed + skipped > 0);
    } catch (e) {
      setNote(`Market prices failed: ${e.message}; keeping the prices typed in.`, true);
    } finally {
      ui.refresh.disabled = false;
    }
  }

  function setSource(source) {
    promotePending = source === 'live' && S.priceSource !== 'live';
    S.priceSource = source;
    paintSource();
    OD.changed(false);
    if (source === 'live') refreshPrices(); else setNote('Type current prices in the Premium column.');
  }

  function paintSource() {
    const live = S.priceSource === 'live';
    ui.manualBtn.classList.toggle('on', !live);
    ui.liveBtn.classList.toggle('on', live);
    ui.manualBtn.setAttribute('aria-pressed', String(!live));
    ui.liveBtn.setAttribute('aria-pressed', String(live));
    ui.refresh.hidden = !live;
  }

  // ---------------------------------------------------------------- entry inputs
  const ENTRY_FIELDS = [
    ['date', 'Entry date', { type: 'date' }],
    ['spot', 'Underlying at entry', { type: 'number', step: 'any', min: '0' }],
    ['iv', 'IV at entry %', { type: 'number', step: '0.1', min: '0' }],
  ];

  function readEntry(field, raw) {
    const v = String(raw).trim();
    if (field === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    return v !== '' && Number.isFinite(+v) && +v > 0 ? +v : null;
  }

  function syncEntryInputs() {
    ENTRY_FIELDS.forEach(([field]) => {
      const input = ui.entry[field];
      const v = S.entry && S.entry[field] != null ? String(S.entry[field]) : '';
      if (input !== document.activeElement && input.value !== v) input.value = v;
    });
    paintSource();
  }

  // ---------------------------------------------------------------- render
  const cell = (text, cls = '') => el('td', { textContent: text, className: cls });

  function table(rows, totals) {
    const head = el('tr', {}, ...['Leg', 'My fill', 'Current', 'Change', 'Unrealised P&L'].map((t) => el('th', { textContent: t })));
    const body = rows.map((r) => el('tr', {}, cell(r.label), cell(fmt(r.fill)), cell(fmt(r.current)),
      cell(signed(r.change), tone(r.change)), cell(r.fill === null ? 'no fill' : money(r.pnl), tone(r.pnl))));
    const total = el('tr', { className: 'pos-total' }, cell('Total'), cell(''), cell(''), cell(''),
      cell(money(totals.pnl), tone(totals.pnl)));
    return el('table', { className: 'pos-table' }, el('thead', {}, head), el('tbody', {}, ...body, total));
  }

  function attribution(view) {
    if (!view.check.ok) {
      return el('p', { className: 'pos-hint', textContent: `The breakdown since entry needs the ${view.check.missing.join(', ')}.` });
    }
    if (!view.attr) return el('p', { className: 'pos-hint', textContent: 'The breakdown since entry could not be priced.' });
    const a = view.attr;
    const lines = [['Underlying move', a.move, `${fmt(S.entry.spot)} → ${fmt(S.spot)}`],
      ['Time decay', a.time, `${fmt(view.check.daysHeld, 1)} days held`],
      ['IV change', a.iv, 'mean IV of the legs vs IV at entry'],
      ['Other', a.other, 'fill and market price vs model value'],
      ['Total since entry', a.total, '']];
    return el('div', { className: 'pos-attr' },
      el('h3', { textContent: 'Since entry' }),
      ...lines.map(([k, v, sub]) => el('div', { className: 'pos-line' + (k.startsWith('Total') ? ' pos-total' : '') },
        el('span', { textContent: k }), el('b', { textContent: money(v), className: tone(v) }), el('em', { textContent: sub }))));
  }

  function render(view) {
    if (!view) {
      ui.body.replaceChildren(el('p', { className: 'pos-hint',
        textContent: 'Enter My fill on a leg to measure P&L from your own price and compare it with the current price.' }));
      return;
    }
    if (view.error) { ui.body.replaceChildren(el('p', { className: 'pos-hint err', textContent: view.error })); return; }
    const unpriced = view.totals.unpriced ? el('p', { className: 'pos-hint err',
      textContent: `${view.totals.unpriced} filled leg${view.totals.unpriced > 1 ? 's have' : ' has'} no current price.` }) : '';
    ui.body.replaceChildren(el('div', { className: 'pos-grid' }, el('div', {}, table(view.rows, view.totals), unpriced),
      attribution(view)));
  }

  // ---------------------------------------------------------------- build
  const STYLE = `
    .pos-card .card-h { flex-wrap: wrap; gap: 8px 12px; }
    .pos-seg { display: inline-flex; gap: 4px; }
    .pos-entry { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
    .pos-entry label { display: flex; align-items: center; gap: 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
    .pos-entry input { background: var(--bg); border: 1px solid var(--line-2); border-radius: 5px; height: 26px; padding: 0 6px; width: 120px; font-family: var(--mono); }
    .pos-body { padding: 10px 14px 12px; }
    .pos-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 18px; }
    table.pos-table { width: 100%; border-collapse: collapse; font: 12px var(--mono); }
    .pos-table th { font: 600 10.5px var(--sans); text-transform: uppercase; letter-spacing: .07em; color: var(--faint); text-align: right; padding: 4px 6px; border-bottom: 1px solid var(--line); }
    .pos-table td { text-align: right; padding: 4px 6px; border-bottom: 1px solid var(--line); }
    .pos-table th:first-child, .pos-table td:first-child { text-align: left; }
    .pos-total td, .pos-line.pos-total { font-weight: 600; }
    .pos-attr h3 { margin: 0 0 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .pos-line { display: grid; grid-template-columns: 1fr auto; gap: 0 10px; padding: 3px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
    .pos-line b { font: 600 12.5px var(--mono); text-align: right; }
    .pos-line em { grid-column: 1 / -1; font: 11px var(--sans); color: var(--faint); font-style: normal; }
    .pos-hint { margin: 0; color: var(--faint); font-size: 12.5px; }
    .pos-hint.err, .pos-live-note.err { color: var(--neg); }
    .pos-live-note { max-width: 520px; }
    .pos-seg .chip.on { color: var(--accent); border-color: var(--accent); }
    .pos-card .btn[hidden] { display: none; }
    @media (max-width: 900px) { .pos-grid { grid-template-columns: 1fr; } }`;

  function build() {
    document.head.append(el('style', { textContent: STYLE }));
    ui.manualBtn = el('button', { className: 'chip', type: 'button', textContent: 'Manual', onclick: () => setSource('manual'),
      title: 'Type current prices in the Premium column' });
    ui.liveBtn = el('button', { className: 'chip', type: 'button', textContent: 'Market', onclick: () => setSource('live'),
      title: 'Market: fetch option prices (mid, or last) once now and when you press Refresh prices' });
    ui.refresh = el('button', { className: 'btn', type: 'button', textContent: 'Refresh prices', onclick: refreshPrices,
      title: 'Fetch current option prices once' });
    ui.liveNote = el('span', { className: 'legend-note pos-live-note' });
    ui.entry = {};
    const entryRow = el('div', { className: 'pos-entry' }, ...ENTRY_FIELDS.map(([field, label, props]) => {
      ui.entry[field] = el('input', { ...props, id: `posentry-${field}`, oninput: (e) => {
        S.entry = { ...S.entry, [field]: readEntry(field, e.target.value) };
        OD.changed(false);
      } });
      return el('label', { htmlFor: `posentry-${field}` }, label, ui.entry[field]);
    }));
    ui.body = el('div', { className: 'pos-body' });
    const card = el('section', { className: 'card pos-card', ariaLabel: 'Position vs my fills' },
      el('div', { className: 'card-h' }, el('h2', { textContent: 'Position vs my fills' }),
        el('span', { className: 'legend-note', textContent: 'Current prices:' }),
        el('span', { className: 'pos-seg', role: 'group', ariaLabel: 'Current price source' }, ui.manualBtn, ui.liveBtn),
        ui.refresh, ui.liveNote),
      entryRow, ui.body);
    // Right after the chart card, so the chart sits directly under the legs.
    document.getElementById('chart').closest('section').after(card);
  }

  build();
  syncEntryInputs();
  render(null);
  const prior = OD.afterRun;
  OD.afterRun = () => { try { prior(); } finally { refresh().catch((e) => console.error('position panel failed', e)); } };
  refresh().catch((e) => console.error('position panel failed', e));
  if (S.priceSource === 'live') refreshPrices();    // once on load; never on a timer
})();
