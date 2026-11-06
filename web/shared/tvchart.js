/* TradingView's free embeddable Advanced Chart, used on the Chain & screener page's Chart tab
 * and in the Options Analyser's collapsible Chart card (modules/analyser/web/tvpanel.js).
 * It has its own symbol search, and it follows the symbol loaded at the top of the page.
 *
 * TradingView is a third-party, online-only service: its script loads from s3.tradingview.com
 * and the chart runs in a TradingView iframe, so nothing from this app is sent to it except the
 * symbol and theme in the widget config. Everything else in OptionDash still works offline.
 *
 * Pure parts (tvSymbol, config) run in Node for the tests; mount() needs a browser.
 * window.TVChart / Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TVChart = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCRIPT_URL = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

  // Free widgets cannot show the exchange index feeds (SP:SPX, TVC:VIX, ... give "only available
  // on TradingView"), so indexes are charted from a CFD that tracks them; each was checked to
  // load in the widget. XSP and DJX are a tenth / hundredth of their index: the chart shows the
  // full-size index. Stocks and ETFs resolve from the bare ticker.
  const INDEXES = Object.freeze({
    SPX: 'FOREXCOM:SPXUSD', XSP: 'FOREXCOM:SPXUSD', NDX: 'FOREXCOM:NSXUSD', RUT: 'FOREXCOM:US2000',
    DJX: 'FOREXCOM:DJI', VIX: 'CAPITALCOM:VIX',
  });

  /** Our symbol (SPY, SPX, BRK.B) to TradingView's. Null for anything that is not a ticker. */
  function tvSymbol(symbol) {
    const s = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(s)) return null;
    return INDEXES[s] || s; // TradingView takes share classes in the dot form too (BRK.B)
  }

  /** The widget's JSON config. theme: 'dark' | 'light'. */
  function config({ symbol, theme }) {
    const dark = theme !== 'light';
    return {
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'America/New_York',
      theme: dark ? 'dark' : 'light',
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      calendar: false,
      hide_volume: false,
      support_host: 'https://www.tradingview.com',
    };
  }

  /**
   * Build the widget in `host` (replacing whatever was there). Returns a function that tears it
   * down. onError(message) is called if TradingView's script cannot be loaded (offline).
   */
  function mount(host, { symbol, theme, onError }) {
    const doc = host.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'tradingview-widget-container';
    wrap.style.height = '100%';
    wrap.style.width = '100%';
    const inner = doc.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = 'calc(100% - 32px)';
    inner.style.width = '100%';
    const credit = doc.createElement('div');
    credit.className = 'tradingview-widget-copyright';
    // TradingView's attribution, as their embed code has it; their terms require it to stay visible.
    const link = doc.createElement('a');
    link.href = 'https://www.tradingview.com/';
    link.rel = 'noopener nofollow';
    link.target = '_blank';
    const blue = doc.createElement('span');
    blue.className = 'blue-text';
    blue.textContent = 'Track all markets on TradingView';
    link.append(blue);
    credit.append(link);
    const script = doc.createElement('script');
    script.type = 'text/javascript';
    script.src = SCRIPT_URL;
    script.async = true;
    script.textContent = JSON.stringify(config({ symbol, theme }));
    // A detached script can still fail later: only report it while this chart is the one shown.
    script.addEventListener('error', () => {
      if (onError && host.firstChild === wrap) onError('Could not reach TradingView. The chart needs an internet connection.');
    });
    wrap.append(inner, credit, script);
    host.replaceChildren(wrap);
    return () => host.replaceChildren();
  }

  return { SCRIPT_URL, INDEXES, tvSymbol, config, mount };
});
