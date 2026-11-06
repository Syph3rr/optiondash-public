// The Options Analyser's "Chart" view: TradingView's embedded chart (web/shared/tvchart.js) for the
// analyser's symbol, shown as the second tab of the chart card (P&L, Chart, Heatmap, ...). On that
// tab it replaces the Plotly plot and hides the P&L controls (date, IV shift, range), which do not
// apply to a price chart; the summary strip stays. It follows the loaded symbol (market.js fires
// `od:symbol` at the end of applyLoaded); before any Load it shows the symbol box's starting value.
//
// The page announces every view switch with `od:view` (showView in index.html). The widget is built
// only while its tab is showing (it needs a real size), rebuilt only when the symbol or theme
// changes, and torn down when another tab is picked, so no TradingView iframe runs out of sight.
// The chosen tab is remembered with the rest of the analyser state (S.view), not here.
//
// Pure parts (isTvView, pickSymbol, needsBuild) run in Node for the tests.
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("tvpanel.js", JS, "../modules/analyser/web/tvpanel.js"),
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.ODTVPanel = api;
    if (root.document) api.start(root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TV_VIEW = 'tv';
  const SYMBOL_EVENT = 'od:symbol';
  const VIEW_EVENT = 'od:view';
  const NONE = Object.freeze({ symbol: '', theme: '' });

  /** Whether the chart card's view is the price chart. */
  const isTvView = (view) => view === TV_VIEW;

  /** The symbol to chart: the loaded one, else the page's starting symbol. Upper-cased, trimmed. */
  function pickSymbol({ loaded, initial } = {}) {
    const clean = (s) => String(s || '').trim().toUpperCase();
    return clean(loaded) || clean(initial);
  }

  /** Whether the widget must be (re)built: forced, or the symbol or theme differs from what is shown. */
  function needsBuild(built, want, force = false) {
    if (!want || !want.symbol) return false;
    return force || !built || built.symbol !== want.symbol || built.theme !== want.theme;
  }

  // ------------------------------------------------------------------ browser wiring
  const STYLE = `
    #chartcard .tv-pane { display: none; }
    #chartcard.tv-on .tv-pane { display: block; }
    #chartcard.tv-on #chart, #chartcard.tv-on > .controls, #chartcard.tv-on .gplay { display: none; }
    #chartcard .tv-host { height: min(560px, 65vh); min-height: 360px; padding: 8px 12px 0; }
    #chartcard .tv-empty { padding: 28px 14px; text-align: center; color: var(--faint); }
    #chartcard .tv-note { margin: 6px 14px 10px; display: block; }`;

  function el(doc, tag, props = {}, ...kids) {
    const n = Object.assign(doc.createElement(tag), props);
    n.append(...kids);
    return n;
  }

  /** The price chart's pane, placed inside the chart card right after the Plotly plot. */
  function buildPane(doc) {
    const host = el(doc, 'div', { className: 'tv-host', id: 'tv-chart' });
    const note = el(doc, 'span', { className: 'legend-note tv-note', textContent:
      'Price chart by TradingView (delayed data, needs an internet connection). It follows the symbol you load; '
      + 'search any other in the chart\'s own box. Indexes (SPX, NDX, RUT, VIX) are charted from a CFD that tracks '
      + 'them; XSP and DJX show the full-size index.' });
    return { pane: el(doc, 'div', { className: 'tv-pane', id: 'tvpane' }, host, note), host };
  }

  function start(win) {
    const doc = win.document;
    const card = doc.getElementById('chartcard');
    const plot = doc.getElementById('chart');
    if (!card || !plot) return; // not the analyser page
    const input = doc.getElementById('symbol');
    const initial = input ? input.value : ''; // the starting symbol, never half-typed text
    const OD = win.OptionDash;
    let loaded = '';
    let built = NONE;
    let open = !!(OD && OD.S && isTvView(OD.S.view)); // the tab restored with the analyser state

    doc.head.append(el(doc, 'style', { textContent: STYLE }));
    const ui = buildPane(doc);
    plot.after(ui.pane);

    const theme = () => (doc.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    const empty = (text) => { ui.host.replaceChildren(el(doc, 'div', { className: 'tv-empty', textContent: text })); built = NONE; };
    const note = doc.getElementById('viewnote');

    function render() {
      const raw = pickSymbol({ loaded, initial });
      if (!open) return;
      if (note) note.textContent = raw ? `${raw} · TradingView, delayed` : 'TradingView, delayed';
      const TV = win.TVChart;
      const symbol = TV ? TV.tvSymbol(raw) : null;
      if (!TV) { empty('The chart script did not load.'); return; }
      if (!symbol) { empty('Load a symbol above to see its chart.'); return; }
      const want = { symbol, theme: theme() };
      if (!needsBuild(built, want)) return;
      built = want;
      TV.mount(ui.host, { ...want, onError: (text) => empty(text) }); // empty() resets, so a reopen retries
    }

    function setOpen(next) {
      open = next;
      card.classList.toggle('tv-on', open); // CSS hides the plot and the P&L controls
      if (open) { render(); return; }
      ui.host.replaceChildren(); built = NONE; // no hidden iframe left running
      // A window resize while the plot was hidden left Plotly at its old width; refit it once the
      // page has redrawn it (showView renders right after this event).
      win.requestAnimationFrame(() => {
        try { if (win.Plotly && plot.data) win.Plotly.Plots.resize(plot); } catch (e) { /* the plot redraws on the next change */ }
      });
    }

    win.addEventListener(VIEW_EVENT, (e) => setOpen(isTvView(e && e.detail && e.detail.view)));
    win.addEventListener(SYMBOL_EVENT, (e) => {
      const s = e && e.detail && e.detail.symbol;
      if (typeof s !== 'string' || !s.trim()) return;
      loaded = s;
      render();
    });
    // The theme can change from Settings in another tab; rebuild to match while open.
    new win.MutationObserver(() => { if (open) render(); })
      .observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setOpen(open);
  }

  return { TV_VIEW, SYMBOL_EVENT, VIEW_EVENT, isTvView, pickSymbol, needsBuild, start };
});
