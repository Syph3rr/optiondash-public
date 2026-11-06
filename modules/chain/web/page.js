// Chain & screener page. Loads a symbol (spot + expiries) and, only when asked, one chain.
// It never polls and never connects to TWS by itself. Server text only reaches textContent.
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  // Chart colours from the current theme (dark fallbacks if nav.js is missing).
  const themeColors = () => {
    const t = window.ODPrefs ? window.ODPrefs.colors() : {};
    return { text: t.muted || '#8b95a7', grid: t.line || '#232b38', accent: t.accent || '#f2b84b', blue: t.blue || '#6ea8fe' };
  };
  const state = { symbol: '', spot: null, expiries: [], chain: null, view: 'chart', sort: { key: 'strike', dir: 'asc' },
    chartSymbol: '' };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

  function message(text, isError) {
    const m = $('#message');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = `card ch-msg${isError ? ' err' : ''}`;
  }

  async function call(path, body) {
    const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Accept: 'application/json' } };
    try {
      const res = await fetch(path, init);
      const data = await res.json().catch(() => null);
      if (!res.ok) return { error: (data && (data.error || data.message)) || `request failed (${res.status})`, status: res.status };
      return { data };
    } catch (e) {
      return { error: 'Cannot reach OptionDash. Is it still running?', status: 0 };
    }
  }

  // ---------------------------------------------------------------- symbol + expiries

  const expiryLabel = (e) => {
    const d = new Date(Date.UTC(+e.expiry.slice(0, 4), +e.expiry.slice(4, 6) - 1, +e.expiry.slice(6, 8)));
    const text = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
    return `${text} · ${e.dte.toFixed(1)}d${e.trading_class && e.trading_class !== state.symbol ? ` · ${e.trading_class}` : ''}`;
  };

  // Only the newest request of each kind may change the page. A chain still loading when a new
  // symbol lands belongs to the old symbol, so a symbol load also makes pending chains stale.
  let symbolSeq = 0;
  let chainSeq = 0;

  async function loadSymbol() {
    const symbol = $('#symbol').value.trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return message('Enter a symbol, for example SPY or SPX.', true);
    const mine = ++symbolSeq;
    // The chart has its own data, so it follows the typed symbol even if our market lookup fails.
    state.chartSymbol = symbol;
    if (state.view === 'chart') renderChart({ force: true }); // Load always resets the chart, even to the same symbol
    message('Loading…');
    $('#load-symbol').disabled = true;
    const [u, x] = await Promise.all([call(`/api/market/underlying/${encodeURIComponent(symbol)}`),
      call(`/api/market/expiries/${encodeURIComponent(symbol)}`)]);
    if (mine !== symbolSeq) return; // a newer Load superseded this one
    $('#load-symbol').disabled = false;
    if (u.error) return message(u.status === 404 ? `Symbol ${symbol} not found.` : u.error, true);
    if (x.error) return message(x.error, true);
    chainSeq += 1;
    state.symbol = symbol;
    state.spot = Number.isFinite(u.data.price) ? u.data.price : null;
    state.expiries = x.data.expiries.filter((e) => e.dte >= 0);
    state.chain = null;
    if (u.data.suggested_model) $('#model').value = u.data.suggested_model;
    const sel = $('#expiry');
    sel.replaceChildren(...state.expiries.map((e, i) => Object.assign(el('option', '', expiryLabel(e)), { value: String(i) })));
    sel.disabled = !state.expiries.length;
    $('#load-chain').disabled = !state.expiries.length;
    message(state.spot === null ? `${symbol} has no price right now, so a chain cannot be priced. Press Load again later.` : '');
    $('#asof').textContent = u.data.as_of ? `Spot as of ${u.data.as_of}` : '';
    render();
  }

  // ---------------------------------------------------------------- chain

  async function loadChain() {
    const e = state.expiries[+$('#expiry').value];
    if (!e) return;
    const mine = ++chainSeq;
    const btn = $('#load-chain');
    btn.disabled = true;
    message('Loading chain…');
    const r = await call('/api/market/chain', {
      symbol: state.symbol, expiry: e.expiry, trading_class: e.trading_class, spot: state.spot,
      rate: (parseFloat($('#rate').value) || 0) / 100, div_yield: (parseFloat($('#divy').value) || 0) / 100,
      model: $('#model').value,
    });
    if (mine !== chainSeq) return; // a newer chain or a new symbol superseded this one
    btn.disabled = !state.expiries.length;
    if (r.error) { message(r.error, true); return; }
    state.chain = { ...r.data, label: expiryLabel(e), table: Chain.pivot(r.data.rows) };
    message(state.chain.table.length ? '' : 'No quotes came back for this expiry.', !state.chain.table.length);
    render();
  }

  const quoteText = (q, f) => (q && Number.isFinite(q[f]) ? fmt(q[f]) : '—');

  function side(q, cols) {
    return cols.map(([f, kind]) => el('td', q ? '' : 'dim', kind === 'iv' ? pct(q && q.iv) : kind === 'd' ? fmt(q && q.delta) : quoteText(q, f)));
  }

  function renderChain() {
    const host = $('#view-chain');
    const c = state.chain;
    if (!c || !c.table.length) { host.replaceChildren(el('div', 'ch-empty', c ? 'No quotes for this expiry.' : 'Load a symbol, pick an expiry and press Load chain.')); return; }
    const spot = Number.isFinite(c.spot) ? c.spot : state.spot;
    const atm = Chain.atmStrike(c.table, spot);
    const cols = [['bid'], ['ask'], ['iv', 'iv'], ['delta', 'd']];
    const head = el('tr');
    cols.forEach(([f]) => head.append(el('th', 'side-c', f === 'iv' ? 'IV' : f === 'delta' ? 'Δ' : f[0].toUpperCase() + f.slice(1))));
    head.append(el('th', '', 'Strike'));
    [...cols].reverse().forEach(([f]) => head.append(el('th', 'side-p', f === 'iv' ? 'IV' : f === 'delta' ? 'Δ' : f[0].toUpperCase() + f.slice(1))));
    const body = el('tbody');
    c.table.forEach((r) => {
      const tr = el('tr', r.strike === atm ? 'atm' : '');
      side(r.call, cols).forEach((td) => tr.append(td));
      tr.append(el('td', 'strike', String(r.strike)));
      side(r.put, [...cols].reverse()).forEach((td) => tr.append(td));
      body.append(tr);
    });
    const t = el('table', 'ch-chain');
    t.append(el('thead'), body);
    t.firstChild.append(head);
    const wrap = el('div', 'ch-scroll');
    wrap.append(t);
    host.replaceChildren(wrap);
    const row = body.querySelector('.atm');
    if (row) wrap.scrollTop = row.offsetTop - wrap.clientHeight / 2;
  }

  // ---------------------------------------------------------------- tiles, skew, screener

  function renderTiles() {
    const c = state.chain;
    const move = c ? Chain.expectedMove(c.table, Number.isFinite(c.spot) ? c.spot : state.spot) : null;
    const atmRow = c && move ? c.table.find((r) => r.strike === move.strike) : null;
    const tile = (k, v, s) => { const d = el('div', 'stat'); d.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', s)); return d; };
    $('#tiles').replaceChildren(
      tile('Symbol', state.symbol || '—', state.expiries.length ? `${state.expiries.length} expiries` : 'not loaded'),
      tile('Spot', fmt(state.spot), 'underlying'),
      tile('Expiry', c ? `${fmt(c.dte, 1)}d` : '—', c ? c.label : 'no chain loaded'),
      tile('Implied move', move ? `±${fmt(move.dollars)}` : '—', move ? `${fmt(move.pct)}% · ATM ${move.strike} straddle` : 'needs ATM call and put marks'),
      tile('ATM IV', atmRow && atmRow.call ? pct(atmRow.call.iv) : '—', atmRow && atmRow.put ? `put ${pct(atmRow.put.iv)}` : ''));
  }

  function renderSkew() {
    const host = $('#skew-plot');
    const c = state.chain;
    const spot = c && (Number.isFinite(c.spot) ? c.spot : state.spot);
    const pts = c ? Chain.skew(c.table, spot) : [];
    if (!window.Plotly) { host.replaceChildren(el('div', 'ch-empty', 'Chart library failed to load.')); return; }
    if (!pts.length) { window.Plotly.purge(host); host.replaceChildren(el('div', 'ch-empty', 'Load a chain to see its skew.')); return; }
    host.querySelectorAll('.ch-empty').forEach((n) => n.remove());
    const COLORS = themeColors();
    const axis = { gridcolor: COLORS.grid, linecolor: COLORS.grid, tickfont: { color: COLORS.text, size: 10.5 }, zeroline: false };
    window.Plotly.react(host, [{ x: pts.map((p) => p.strike), y: pts.map((p) => p.iv * 100), type: 'scatter', mode: 'lines+markers',
      line: { color: COLORS.blue, width: 2 }, marker: { size: 6 }, hovertemplate: 'Strike %{x}<br>IV %{y:.1f}%<extra></extra>' }], {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', margin: { l: 52, r: 16, t: 14, b: 40 }, showlegend: false,
      font: { color: COLORS.text }, xaxis: { ...axis, title: 'Strike' }, yaxis: { ...axis, ticksuffix: '%', title: 'IV (OTM options)' },
      shapes: [{ type: 'line', x0: spot, x1: spot, yref: 'paper', y0: 0, y1: 1, line: { color: COLORS.accent, dash: 'dot', width: 1 } }],
    }, { displaylogo: false, responsive: true });
  }

  const num = (id, scale = 1) => { const v = $(id).value; return v === '' ? undefined : parseFloat(v) / scale; };

  function renderScreener() {
    const host = $('#screen-results');
    const c = state.chain;
    if (!c) { host.replaceChildren(el('div', 'ch-empty', 'Load a chain to screen its contracts.')); return; }
    const rows = Chain.screen(c.rows, {
      side: $('#f-side').value, deltaMin: num('#f-dmin'), deltaMax: num('#f-dmax'), minBid: num('#f-bid'),
      maxSpreadPct: num('#f-spread'), ivMin: num('#f-ivmin', 100), ivMax: num('#f-ivmax', 100),
    }, state.sort);
    $('#note').textContent = `${rows.length} of ${c.rows.length} contracts`;
    if (!rows.length) { host.replaceChildren(el('div', 'ch-empty', 'No contracts match these filters.')); return; }
    const cols = [['right', 'Side', 0], ['strike', 'Strike', 1], ['bid', 'Bid', 1], ['ask', 'Ask', 1], ['mark', 'Mark', 1],
      ['spread', 'Spread %', 1], ['iv', 'IV', 1], ['delta', 'Δ', 1]];
    const head = el('tr');
    cols.forEach(([key, label, right]) => {
      const sortable = key !== 'right';
      const th = el('th', `${sortable ? 'sort' : ''}${state.sort.key === key ? ' on' : ''}${right ? '' : ' left'}`.trim(), label);
      if (sortable) th.addEventListener('click', () => {
        state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' };
        renderScreener();
      });
      head.append(th);
    });
    const body = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr');
      [el('td', `left ${r.right === 'C' ? 'pos' : 'neg'}`, r.right === 'C' ? 'Call' : 'Put'), el('td', '', String(r.strike)),
        el('td', '', fmt(r.bid)), el('td', '', fmt(r.ask)), el('td', '', fmt(r.mark)),
        el('td', '', Number.isFinite(r.spreadPct) ? fmt(r.spreadPct, 1) : '—'), el('td', '', pct(r.iv)),
        el('td', '', fmt(r.delta))].forEach((td) => tr.append(td));
      body.append(tr);
    });
    const t = el('table', 'ch-chain');
    const h = el('thead');
    h.append(head);
    t.append(h, body);
    host.replaceChildren(t);
  }

  // ---------------------------------------------------------------- wiring

  // ---------------------------------------------------------------- chart (TradingView)

  // What the chart was last built for; rebuilt only when the symbol or theme changes.
  let chartBuilt = { symbol: '', theme: '' };
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function renderChart({ force = false } = {}) {
    const symbol = window.TVChart ? TVChart.tvSymbol(state.chartSymbol) : null;
    const host = $('#tv-chart');
    if (!window.TVChart || !symbol) {
      host.replaceChildren(el('div', 'ch-empty', 'Enter a symbol above to see its chart.'));
      chartBuilt = { symbol: '', theme: '' };
      return;
    }
    const want = { symbol, theme: theme() };
    if (!force && want.symbol === chartBuilt.symbol && want.theme === chartBuilt.theme) return;
    chartBuilt = want;
    TVChart.mount(host, { ...want, onError: (text) => {
      host.replaceChildren(el('div', 'ch-empty', text));
      chartBuilt = { symbol: '', theme: '' }; // try again next time the tab is shown
    } });
  }

  // Until a Load, the chart shows the page's starting symbol (never half-typed text).
  state.chartSymbol = $('#symbol').value.trim().toUpperCase();

  // The theme can change from Settings in another tab; rebuild the chart to match.
  new MutationObserver(() => { if (state.view === 'chart') renderChart(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function render() {
    if (state.view === 'chart') renderChart(); // built only while visible, so it gets the real size
    renderTiles();
    renderChain();
    if (state.view === 'skew') renderSkew(); // drawn only while visible, so it gets the real width
    renderScreener();
    if (state.view === 'chart') $('#note').textContent = '';
    else if (state.view !== 'screener') $('#note').textContent = state.chain ? `${state.chain.table.length} strikes` : '';
  }

  function show(view) {
    state.view = view;
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    Chain.VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    // Remember the tab in the URL so a reload (or a shared link) opens on it.
    try { history.replaceState(null, '', `#${view}`); } catch (_) { /* file:// or sandboxed: not remembered */ }
    render();
  }

  $('#tabs').addEventListener('click', (e) => { if (e.target.dataset && e.target.dataset.view) show(e.target.dataset.view); });
  $('#load-symbol').addEventListener('click', loadSymbol);
  $('#symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSymbol(); });
  $('#load-chain').addEventListener('click', loadChain);
  $('#filters').addEventListener('input', renderScreener);
  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  $('#f-reset').addEventListener('click', () => { $('#filters').reset(); renderScreener(); });
  // Start from the pricing defaults in Settings (the inputs can still be changed here).
  const defaults = window.ODPrefs ? window.ODPrefs.get() : null;
  if (defaults) {
    $('#rate').value = String(defaults.rate);
    $('#divy').value = String(defaults.divYield);
  }
  // Opens on the Chart unless the URL names a tab. Offline, the chart shows its own message and
  // the other tabs work as usual.
  show(Chain.initialView(location.hash));
})();
