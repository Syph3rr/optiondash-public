// Analyser <-> journal wiring: loads ?journal_trade=N into the analyser, with a one-step Undo,
// and adds a "Log as trade" button that hands the legs to the journal's new-trade form.
// DOM only; the conversions live in journallink.js. Built with DOM calls (no HTML strings).
//
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("journalui.js", JS, "../modules/analyser/web/journalui.js"),
(function () {
  'use strict';
  const OD = window.OptionDash, J = window.ODJournal, K = window.ODControls;
  if (!OD || !J || !K) return;
  const S = OD.S;
  const HOLD_MS = 8000;
  const HEADER_FIELDS = ['symbol', 'spot', 'model', 'rate', 'divy'];
  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...kids) {
    const n = Object.assign(document.createElement(tag), props || {});
    kids.forEach((k) => n.append(k));
    return n;
  }

  function syncHeader() {
    HEADER_FIELDS.forEach((f) => { const input = $(f); if (input && S[f] != null) input.value = S[f]; });
  }

  // ---------------------------------------------------------------- banner
  let banner = null;
  function showBanner(parts) {
    if (banner) banner.remove();
    banner = el('div', { className: 'card jl-banner', role: 'status' }, ...parts);
    banner.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 14px;font-size:12.5px';
    const main = document.querySelector('main');
    main.insertBefore(banner, main.firstChild);
  }
  const link = (text, href) => el('a', { href, textContent: text, style: 'color:var(--accent)' });
  const action = (text, onclick) => el('button', { className: 'chip', type: 'button', textContent: text, onclick });

  // ---------------------------------------------------------------- load a trade
  function snapshot() {
    const copy = JSON.parse(JSON.stringify(S));
    delete copy.tPin;
    return copy;
  }

  function restore(prev) {
    Object.keys(S).forEach((k) => { if (!(k in prev)) delete S[k]; });
    Object.assign(S, prev, { tPin: null });
    syncHeader();
    OD.legsChanged();
    if (banner) banner.remove();
    OD.setStatus('Restored your previous strategy', false, 3000);
  }

  function apply(trade) {
    const prev = S.legs.length ? snapshot() : null;
    const next = J.toAnalyser(trade, Date.now(), K);
    if (!next.legs.length) { OD.setStatus(`Trade #${trade.id} has no legs to load`, true, HOLD_MS); return; }
    Object.assign(S, { symbol: next.symbol, model: next.model, legs: next.legs, entry: next.entry, tSel: null, tPin: null });
    if (window.ODSavedUI) window.ODSavedUI.forget();
    if (next.spot != null) S.spot = next.spot;
    syncHeader();
    OD.legsChanged();
    const what = next.source === 'initial' ? ' (closed: showing the opening position)' : '';
    const expired = next.expired ? ` · ${next.expired} expired leg${next.expired > 1 ? 's' : ''} at intrinsic` : '';
    showBanner([
      el('span', { textContent: `Loaded trade ${J.tradeLabel(trade)}${what}${expired}` }),
      prev ? action('Undo', () => restore(prev)) : '',
      link('View in journal', `/journal/trade?id=${encodeURIComponent(trade.id)}`),
    ]);
  }

  async function loadTrade(id) {
    OD.setStatus(`loading trade #${id} from the journal…`, false, HOLD_MS);
    try {
      const r = await fetch(`/api/journal/trades/${id}`, { headers: { accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) {
        const why = (j && j.error) || (r.status === 503 || r.status === 502 ? 'the journal is offline' : r.statusText);
        throw new Error(`Could not load trade #${id}: ${why}`);
      }
      apply(j.data);
    } catch (e) {
      OD.setStatus(e.message.includes('fetch') ? `Could not load trade #${id}: the journal is offline` : e.message, true, HOLD_MS);
    }
  }

  // ---------------------------------------------------------------- log as trade
  function logAsTrade() {
    const R = OD.result();
    const theos = S.legs.map((_, i) => (R && R.legs[i] ? R.legs[i].theo : undefined));
    const prefill = J.toPrefill(S, theos, Date.now(), K);
    if (!prefill.legs.length) { OD.setStatus('Add or enable at least one leg to log a trade', true, HOLD_MS); return; }
    try { sessionStorage.setItem(J.PREFILL_KEY, JSON.stringify(prefill)); }
    catch (e) { OD.setStatus('Could not hand the legs to the journal (browser storage is blocked)', true, HOLD_MS); return; }
    window.location.href = '/journal/?new=1&from=analyser';
  }

  function addButton() {
    const anchor = document.querySelector('[data-add="stock"]');
    if (!anchor) return;
    const b = el('button', { className: 'btn primary', type: 'button', textContent: 'Log as trade',
      title: 'Open the journal\'s new-trade form with these legs filled in', onclick: logAsTrade });
    anchor.after(b);
  }

  addButton();
  const id = J.tradeIdFrom(window.location.search);
  if (id != null) {
    const url = new URL(window.location.href);
    url.searchParams.delete('journal_trade');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    loadTrade(id);
  }
})();
