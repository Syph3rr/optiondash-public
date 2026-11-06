// Earnings panel: report date, what the model reads from the legs, IV after per leg, and the
// before/after overlay with Play on the P&L chart. The pure helpers are exported for Node tests.
//
// Nothing here uses innerHTML. Yahoo's reply and typed values reach the DOM through textContent
// or element properties.
(function (root) {
  'use strict';
  const FRAMES = 24;
  const PLAY_MS = 3000;
  const DATE_LOOK_MS = 2000;     // how often to notice that a new symbol was loaded
  // Theme colours (see /shared/theme.css), with the dark values as a fallback.
  // Outside a browser (the Node tests) there is no page to read, so the fallback is used.
  const themeVar = (name, fallback) => (typeof getComputedStyle === 'function' && typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '') || fallback;
  const VIOLET = themeVar('--violet', '#a78bfa');
  const BAND = themeVar('--violet-bg', 'rgba(167,139,250,.09)');
  const WHEN = new Map([['amc', 'After close'], ['bmo', 'Before open']]);

  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  /** @returns {number|null} P&L at a price, read off a curve by straight lines between points */
  function pnlAt(xs, ys, price) {
    if (!xs.length || price < xs[0] || price > xs[xs.length - 1]) return null;
    const i = Math.min(xs.findIndex((x) => x >= price), xs.length - 1);
    if (i <= 0) return ys[0];
    const w = (price - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + w * (ys[i] - ys[i - 1]);
  }

  /** @returns {string} e.g. 'SELL 2 × 270C' */
  const legLabel = (l) => `${l.long ? 'BUY' : 'SELL'} ${l.qty} × ${l.strike}${l.kind === 'call' ? 'C' : 'P'}`;

  /**
   * What the frames depend on, rounded so that Live's small ticks do not throw away 24 priced
   * frames on every poll. @returns {string}
   */
  function frameKey(bodies) {
    const r = (x, d) => (typeof x === 'number' ? +x.toPrecision(d) : x);
    const norm = (b) => ({ ...b, spot: r(b.spot, 4), at_days: b.at_days.map((t) => r(t, 3)),
      legs: b.legs.map((l) => ({ ...l, iv: r(l.iv, 3), dte: r(l.dte, 3), premium: r(l.premium, 4) })) });
    return JSON.stringify(bodies.map(norm));
  }

  /** @returns {number} index of the time nearest t */
  const nearestIndex = (times, t) => times.reduce((bi, v, i) => (Math.abs(v - t) < Math.abs(times[bi] - t) ? i : bi), 0);

  const api = { pnlAt, legLabel, nearestIndex, frameKey };
  root.ODEarnPanel = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------ page state
  const OD = root.OptionDash;
  const S = OD.S;
  const E = root.ODEarnings;
  const P = { times: null, model: null, after: null, frames: null, framesKey: '', frame: null, shown: null, seq: 0,
    legsKey: '', building: null, again: false, playing: false, fetchedFor: null, failed: '', ui: {} };
  if (!S.earn || typeof S.earn !== 'object') S.earn = { on: false, symbol: null, date: '', when: 'amc', typed: false, source: '' };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }
  const setProp = (node, prop, value) => { if (node[prop] !== value) node[prop] = value; };
  const money = (x) => (num(x) ? `${x < 0 ? '−' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}` : '—');
  const setEarn = (patch) => { S.earn = { ...S.earn, ...patch }; OD.changed(false); };
  /** The legs as the last pricing reply saw them: its entries line up with these, by index. */
  const legsKey = () => S.legs.map((l) => `${l.id}:${l.enabled}:${l.qty}:${l.kind}:${l.strike}:${l.premium}`).join('|');

  // ------------------------------------------------------------------ pricing
  async function price(legs, atDays) {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OD.pricingBody(legs, [atDays], 2)) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    const i = nearestIndex(j.times, atDays);
    // The engine leaves out a time past the last expiry: then there is no curve at that moment.
    return Math.abs(j.times[i] - atDays) < 1e-6 ? { x: j.prices, y: j.grid.pnl[i] } : null;
  }

  const entriesOf = (R) => R.legs.map((info) => (info ? info.entry : null));
  /**
   * Today's legs with blank premiums pinned to today's entry, the legs after the report, and a
   * key for both. Null while the legs differ from the ones the last reply priced.
   */
  function scenario() {
    const R = OD.result();
    if (!R || !P.times || legsKey() !== P.legsKey) return null;
    const entries = entriesOf(R);
    const from = S.legs.map((l, i) => ({ ...l, premium: l.premium ?? entries[i] }));
    const to = E.afterLegs(S.legs, P.model, P.times.eventDays, entries);
    const key = frameKey([OD.pricingBody(from, [0], 2), OD.pricingBody(to, [P.times.afterDays], 2)]);
    return { from, to, key, afterDays: P.times.afterDays };
  }

  /** Runs after every pricing reply: the model and the after curve follow the legs. */
  async function refresh() {
    try {
      await refreshAfter();
    } catch (e) {
      console.error('earnings refresh failed', e);
      P.failed = `earnings model failed: ${e.message}`;
      paint();
    }
  }

  async function refreshAfter() {
    P.times = S.earn.on ? E.eventTimes(S.earn.date, S.earn.when, Date.now()) : null;
    P.model = P.times ? E.eventModel(S.legs, P.times.eventDays) : null;
    P.legsKey = legsKey();
    P.failed = '';
    const seq = ++P.seq;
    const sc = OD.result() && S.legs.some((l) => l.enabled) ? scenario() : null;
    if (!sc) {
      Object.assign(P, { after: null, frames: null, frame: null, shown: null, framesKey: '' });
      paint(); OD.redrawChart(); return;
    }
    if (sc.key !== P.framesKey) {
      P.frames = null;
      if (P.frame !== null && !P.playing) rebuildFrames();
    }
    try {
      const after = await price(sc.to, sc.afterDays);
      if (seq !== P.seq) return;
      P.after = after;
      P.failed = after ? '' : 'the report comes after the last expiry, so there is nothing left to price';
    } catch (e) {
      if (seq !== P.seq) return;
      P.after = null;
      P.failed = `after-report pricing failed: ${e.message}`;
    }
    paint();
    OD.redrawChart();
  }

  /**
   * Prices the 24 frames from one snapshot, so they are always usable together; they are kept
   * as current only while the inputs still match. One build at a time: a caller arriving
   * mid-build shares it. @returns {Promise<object[]|null>} null while the legs are being repriced
   */
  function buildFrames() {
    if (P.building) return P.building;
    const sc = scenario();
    if (!sc) return Promise.resolve(null);
    const steps = [...Array(FRAMES).keys()].map((i) => i / (FRAMES - 1));
    P.building = Promise.all(steps.map((p) => price(E.frameLegs(sc.from, sc.to, p), p * sc.afterDays)))
      .then((curves) => {
        const frames = curves.map((c, i) => ({ p: steps[i], curve: c }));
        const now = scenario();
        if (now && now.key === sc.key) Object.assign(P, { frames, framesKey: sc.key });
        return frames;
      })
      .finally(() => { P.building = null; });
    return P.building;
  }

  /**
   * Keeps a scrubbed-to frame on screen, repriced, when Live or an edit moves the inputs. While
   * a build is out, later moves wait for it and then trigger one more, never a pile of them.
   */
  async function rebuildFrames() {
    if (P.building) { P.again = true; return; }
    try {
      const frames = await buildFrames();
      if (frames && P.frame !== null && !P.playing) {
        P.shown = frames[P.frame];
        OD.redrawChart();
      }
    } catch (e) {
      OD.setStatus(`frames failed: ${e.message}`, true);
    }
    if (P.again) {
      P.again = false;
      if (!P.frames && P.frame !== null) rebuildFrames();
    }
  }

  // ------------------------------------------------------------------ chart overlay
  OD.payoffExtras = () => {
    const out = { traces: [], shapes: [], note: '' };
    if (!S.earn.on || !P.times) return out;
    if (P.model && P.model.ok && P.model.move > 0) {
      const m = P.model.move / 100;
      out.shapes.push({ type: 'rect', layer: 'below', x0: S.spot * (1 - m), x1: S.spot * (1 + m), y0: 0, y1: 1,
        yref: 'paper', fillcolor: BAND, line: { width: 0 } });
    }
    if (P.after) {
      out.traces.push({ x: P.after.x, y: P.after.y, type: 'scatter', mode: 'lines', line: { color: VIOLET, width: 2.4 },
        hovertemplate: 'after report %{y:$,.0f}<extra></extra>' });
      out.note = ` &nbsp; <span style="color:${VIOLET}">━</span> after report`;
    }
    const f = P.frame !== null ? P.shown : null;
    if (f && f.curve) {
      out.traces.push({ x: f.curve.x, y: f.curve.y, type: 'scatter', mode: 'lines',
        line: { color: themeVar('--text', '#e6e9ef'), width: 2, dash: 'dot' }, hovertemplate: `${Math.round(f.p * 100)}% of the way %{y:$,.0f}<extra></extra>` });
    }
    return out;
  };

  // ------------------------------------------------------------------ panel
  function paintSummary() {
    const { summary, outcome } = P.ui;
    if (!S.earn.on) return;
    let text = '';
    if (!S.earn.date) text = 'Enter the report date.';
    else if (!P.times) text = 'That report is already out, so today\'s IVs no longer carry it.';
    else if (!P.model.ok) text = `Model: ${P.model.reason}. Type an IV after for each leg instead.`;
    else {
      const m = P.model;
      text = `Earnings move ±${m.move.toFixed(1)}% (1σ) · normal vol ${m.baseIv.toFixed(1)}%, the forward vol `
        + `from ${m.front.dte.toFixed(1)}d to ${m.back.dte.toFixed(1)}d${m.note ? ` · ${m.note}` : ''}`;
    }
    setProp(summary, 'textContent', text);
    let result = P.failed || '';
    if (P.after && P.times) {
      const at = (k) => pnlAt(P.after.x, P.after.y, S.spot * (1 + k));
      const move = P.model && P.model.ok ? P.model.move / 100 : 0;
      const moves = move > 0 ? ` · stock down 1σ ${money(at(-move))} · up 1σ ${money(at(move))}` : '';
      result = `After the report (${OD.tLabel(P.times.afterDays, true)}), stock unchanged ${money(at(0))}${moves}`;
    }
    setProp(outcome, 'textContent', result);
  }

  function legRow(l) {
    const input = el('input', { type: 'number', min: '0', step: '0.1', className: 'earn-iv',
      title: 'Blank uses the model. Type your own estimate to override it.' });
    input.oninput = () => {
      const leg = S.legs.find((x) => x.id === l.id);
      if (!leg) return;
      const v = input.value.trim();
      Object.assign(leg, { ivAfter: v !== '' && num(+v) && +v > 0 ? +v : null });
      OD.changed(false);
    };
    return el('tr', {}, el('td'), el('td'), el('td', { className: 'num' }), el('td', {}, input));
  }

  function paintRows() {
    const { rows } = P.ui;
    const legs = S.legs.filter((l) => l.kind !== 'stock');
    const key = legs.map((l) => l.id).join(',');
    if (rows.dataset.key !== key) {
      rows.replaceChildren(...legs.map(legRow));
      rows.dataset.key = key;
    }
    legs.forEach((l, i) => {
      const tr = rows.children[i];
      const [name, when, now, after] = tr.children;
      const before = P.times && !(l.dte > P.times.eventDays);
      setProp(tr, 'className', l.enabled ? '' : 'off');
      setProp(name, 'textContent', legLabel(l));
      setProp(when, 'textContent', `${OD.dteSub(l.dte)}${before ? ' · expires before the report' : ''}`);
      setProp(now, 'textContent', `${(+l.iv).toFixed(1)}%`);
      const input = after.firstChild;
      const model = P.model && P.times ? E.ivAfter(l, P.model, P.times.eventDays) : l.iv;
      setProp(input, 'placeholder', before ? '—' : model.toFixed(1));
      setProp(input, 'disabled', !!before);
      if (input !== document.activeElement) setProp(input, 'value', num(l.ivAfter) ? String(l.ivAfter) : '');
    });
  }

  function paint() {
    const { body, on, date, when, source, play, scrub } = P.ui;
    setProp(on, 'checked', !!S.earn.on);
    setProp(body, 'hidden', !S.earn.on);
    if (!S.earn.on) return;
    if (date !== document.activeElement) setProp(date, 'value', S.earn.date || '');
    setProp(when, 'value', WHEN.has(S.earn.when) ? S.earn.when : 'amc');
    setProp(source, 'textContent', S.earn.source || '');
    setProp(play, 'disabled', !P.after || P.playing);
    setProp(play, 'textContent', P.playing ? 'Playing…' : '▶ Play');
    setProp(scrub, 'disabled', !P.after || P.playing);
    if (P.frame === null && !P.playing) setProp(scrub, 'value', '0');
    paintSummary();
    paintRows();
  }

  // ------------------------------------------------------------------ play
  /** @returns {Promise<object[]|null>} the frames, priced now if Live or an edit dropped them */
  async function ensureFrames() {
    if (P.frames) return P.frames;
    OD.setStatus('pricing the before → after frames…');
    try {
      const frames = await buildFrames();
      OD.setStatus(frames ? 'before → after frames ready' : 'the legs are being repriced; try again in a moment', !frames);
      return frames;
    } catch (e) {
      OD.setStatus(`frames failed: ${e.message}`, true);
      return null;
    }
  }

  /** Shows one frame. The curve is kept, not looked up, so a Live tick mid-play cannot drop it. */
  function showFrame(frames, i) {
    P.frame = i <= 0 ? null : Math.min(i, FRAMES - 1);
    P.shown = P.frame === null ? null : frames[P.frame];
    setProp(P.ui.scrub, 'value', String(Math.max(i, 0)));
    OD.redrawChart();
  }

  async function play() {
    if (P.playing || !P.after) return;
    if (OD.S.view !== 'payoff') OD.showView('payoff');
    P.playing = true;
    paint();
    let frames = null;
    try {
      frames = await ensureFrames(); // played to the end even if Live reprices meanwhile
      for (let i = 0; frames && i < FRAMES; i++) {
        showFrame(frames, i);
        await new Promise((done) => { setTimeout(done, PLAY_MS / FRAMES); });
      }
    } catch (e) {
      OD.setStatus(`play failed: ${e.message}`, true);
      P.frame = null;
      P.shown = null;
    } finally {
      P.playing = false;
      paint();
    }
    if (frames && !P.frames && P.frame !== null) rebuildFrames(); // catch up with what Live moved
  }

  async function onScrub() {
    if (OD.S.view !== 'payoff') OD.showView('payoff');
    const frames = +P.ui.scrub.value > 0 ? await ensureFrames() : [];
    if (frames) showFrame(frames, +P.ui.scrub.value); // it may have moved while frames were priced
  }

  // ------------------------------------------------------------------ report date
  async function lookUpDate(force = false) {
    const symbol = S.loadedSymbol;
    if (!symbol || (!force && P.fetchedFor === symbol)) return;
    P.fetchedFor = symbol;
    if (!force && S.earn.symbol === symbol && S.earn.typed) return; // keep a date typed for this symbol
    S.earn = { ...S.earn, source: 'looking up the report date…' }; // a label only: no pricing run
    paint();
    let found = null;
    let error = '';
    try {
      const r = await fetch(`/api/market/earnings/${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      found = j;
    } catch (e) {
      error = e.name === 'TimeoutError' ? 'timed out' : e.message;
    }
    if (S.loadedSymbol !== symbol) return;
    const date = found && typeof found.date === 'string' ? found.date : '';
    const when = found && WHEN.has(found.when) ? found.when : 'amc';
    const source = error ? `date lookup failed: ${error}` : !date ? 'Yahoo has no report date for this symbol'
      : found.when ? 'from Yahoo' : 'from Yahoo · timing not known, check it';
    setEarn({ symbol, typed: false, date: error ? S.earn.date : date, when: error ? S.earn.when : when, source });
  }

  // ------------------------------------------------------------------ setup
  const STYLE = `
    #earncard .earn-row { display: flex; align-items: flex-end; gap: 12px; padding: 10px 14px; flex-wrap: wrap; }
    #earncard .earn-on { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); cursor: pointer; }
    #earncard .earn-text { padding: 0 14px 8px; font: 12px/1.6 var(--mono); color: var(--text); }
    #earncard .earn-text.out { color: ${VIOLET}; }
    #earncard table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #earncard th { text-align: left; font-weight: 600; font-size: 10.5px; color: var(--faint); padding: 4px 14px; text-transform: uppercase; letter-spacing: .06em; }
    #earncard td { padding: 3px 14px; border-top: 1px solid var(--line); color: var(--text); }
    #earncard tr.off td { opacity: .45; }
    #earncard .earn-iv { width: 90px; background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; height: 26px; padding: 0 6px; }
    #earncard .earn-play { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--line); }
    #earncard .earn-play input[type=range] { flex: 1; }
    #earncard [hidden] { display: none; }`;

  function build() {
    const ui = P.ui;
    ui.on = el('input', { type: 'checkbox', onchange: () => { setEarn({ on: ui.on.checked }); lookUpDate(); } });
    ui.date = el('input', { type: 'date', oninput: () => setEarn({ date: ui.date.value, typed: true,
      symbol: S.loadedSymbol || null, source: 'typed' }) });
    ui.when = el('select', { onchange: () => setEarn({ when: ui.when.value }) },
      ...[...WHEN].map(([value, textContent]) => el('option', { value, textContent })));
    ui.source = el('span', { className: 'legend-note' });
    ui.yahoo = el('button', { className: 'iconbtn', textContent: 'Yahoo', title: 'Look the date up again',
      onclick: () => lookUpDate(true) });
    ui.summary = el('div', { className: 'earn-text' });
    ui.outcome = el('div', { className: 'earn-text out' });
    ui.rows = el('tbody');
    ui.play = el('button', { className: 'btn', textContent: '▶ Play', onclick: play });
    ui.scrub = el('input', { type: 'range', min: '0', max: String(FRAMES - 1), value: '0', step: '1', oninput: onScrub });
    ui.scrub.setAttribute('aria-label', 'Before to after the report');
    const field = (label, input) => el('div', { className: 'field' }, el('label', { textContent: label }), input);
    const head = el('tr', {}, ...['Leg', 'Expiry (New York)', 'IV now', 'IV after'].map((t) => el('th', { textContent: t })));
    ui.body = el('div', {},
      el('div', { className: 'earn-row' }, field('Report date (New York)', ui.date), field('Timing', ui.when), ui.yahoo, ui.source),
      ui.summary, ui.outcome,
      el('table', {}, el('thead', {}, head), ui.rows),
      el('div', { className: 'earn-play' }, ui.play, el('span', { className: 'legend-note', textContent: 'Before' }), ui.scrub,
        el('span', { className: 'legend-note', textContent: 'After' })));
    const card = el('section', { className: 'card', id: 'earncard' },
      el('div', { className: 'card-h' }, el('h2', { textContent: 'Earnings' }),
        el('label', { className: 'earn-on' }, ui.on, el('span', { textContent: 'Model the report' })),
        el('span', { className: 'legend-note', textContent: 'Purple = after the report, with the IV it carried taken out. Shaded = ±1σ earnings move.' })),
      ui.body);
    // After the chart card (the position panel, loaded later, lands between them).
    document.getElementById('chart').closest('section').after(card);
  }

  document.head.append(el('style', { textContent: STYLE }));
  build();
  OD.afterRun = refresh;
  paint();
  setInterval(() => { if (S.earn.on) lookUpDate(); }, DATE_LOOK_MS);
  refresh();
})(globalThis);
