// Greeks animation: plays the Greeks × Price and Greeks × Time charts between two dates.
// All frames are priced in one /api/analyze request; the charts in index.html draw whichever
// frame OptionDash.greekFrame() returns. The pure helpers live in greekframes.js.
//
// Nothing here uses innerHTML: the DOM is built with createElement and textContent.
(function (root) {
  'use strict';
  const { FRAMES, frameTimes, frameIndexes, yRange, priceRanges, frameAt, mergeCurve, playSpan, applyPick,
    cleanSel, frameKey, frameAtElapsed } = root.ODGreekFrames;
  const DAY_MS = 86400000;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  // ------------------------------------------------------------------ page state
  const OD = root.OptionDash;
  const K = root.ODControls;
  const S = OD.S;
  const PLAY_MS = 4000;
  const REQUEST_MS = 20000;
  const KEYS = ['delta', 'gamma', 'theta', 'vega']; // the four panels quad() draws
  const GREEK_VIEWS = new Set(['gprice', 'gtime']);
  const P = { set: null, shown: null, building: null, again: false, failedKey: '', playing: false, playId: 0,
    legsKey: '', note: '', merged: null, ui: {} };
  if (!S.greekPlay || typeof S.greekPlay !== 'object') S.greekPlay = { from: null, to: null };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }
  const setProp = (node, prop, value) => { if (node[prop] !== value) node[prop] = value; };
  const setIdle = (node, value) => { if (node !== document.activeElement) setProp(node, 'value', value); };
  const lastDays = (R) => R.times[R.times.length - 1] || 0;
  const firstExpiry = (R) => (R.expiries.length ? R.expiries[0] : R.summary.first_expiry);
  const greekView = () => GREEK_VIEWS.has(S.view);
  /** Frames hold instants; they become days from now only when drawn, so labels never drift. */
  const daysAt = (ms) => (ms - Date.now()) / DAY_MS;
  const frameLabel = ({ set, i }) => OD.tLabel(daysAt(set.frames[i].ms), true);
  /** Leg edits stop playback; IV and premium are left out because Live moves them on its own. */
  const legsKey = () => S.legs.map((l) => [l.id, l.enabled, l.kind, l.long, l.qty, l.strike, (+l.dte).toFixed(2),
    l.multiplier].join(':')).join('|');

  /** @returns {object} the span to play, its frame times and cache key, or why it cannot play */
  function plan() {
    const R = OD.result();
    if (!R) return { ok: false, reason: 'waiting for the first pricing' };
    const nowMs = Date.now();
    const span = playSpan(S.greekPlay, nowMs, firstExpiry(R), lastDays(R));
    if (!span.ok) return span;
    const times = frameTimes(span.from, span.to);
    const body = OD.pricingBody(S.legs, times, 2);
    return { ...span, nowMs, times, body, key: frameKey(body, S.greekPlay) };
  }

  // ------------------------------------------------------------------ pricing
  async function fetchFrames(pl) {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pl.body), signal: AbortSignal.timeout(REQUEST_MS) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    const idx = frameIndexes(j.times, pl.times);
    if (idx.includes(-1)) throw new Error('the server left out some frame times');
    const frames = idx.map((i) => frameAt(j, i, KEYS, pl.nowMs));
    return { key: pl.key, fromMs: pl.fromMs, toMs: pl.toMs, frames, priceRanges: priceRanges(frames, KEYS) };
  }

  /** One request at a time. A caller wanting the inputs already out shares that request; one wanting
   *  newer inputs waits for it to finish first. @returns {Promise<object>} */
  function ensureFrames(pl) {
    if (P.set && P.set.key === pl.key) return Promise.resolve(P.set);
    if (P.building && P.building.key === pl.key) return P.building.promise;
    const before = P.building ? P.building.promise.catch(() => null) : Promise.resolve(null);
    const job = { key: pl.key };
    job.promise = before.then(() => fetchFrames(pl))
      .then((set) => { P.set = set; P.failedKey = ''; return set; })
      .catch((e) => { P.failedKey = pl.key; throw e; })
      .finally(() => { if (P.building === job) P.building = null; });
    P.building = job;
    return job.promise;
  }

  /** @returns {Promise<object|null>} the frames for Play or the scrubber; failures are shown, not thrown */
  async function pricedFrames() {
    const pl = plan();
    if (!pl.ok) { paint(); return null; }
    if (P.set && P.set.key === pl.key) return P.set;
    OD.setStatus(`pricing ${FRAMES} Greeks frames…`);
    try {
      const set = await ensureFrames(pl);
      OD.setStatus('Greeks frames ready');
      return set;
    } catch (e) {
      OD.setStatus(`Greeks frames failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`, true);
      return null;
    }
  }

  /** Keeps a scrubbed-to frame current when Live or an edit moves the inputs. While a request is out,
   *  later moves wait for it and then trigger one more, never a pile of them. */
  async function refreshShown() {
    if (P.building) { P.again = P.again || !!P.shown; return; }
    P.again = false;
    if (!P.shown || P.playing) return;
    const pl = plan();
    if (!pl.ok) { clearShown(); return; }
    if (P.shown.set.key === pl.key) return;
    if (pl.key === P.failedKey) { clearShown(); return; } // already failed: no retry loop, no stale frame
    try {
      const set = await ensureFrames(pl);
      if (P.shown && !P.playing && greekView()) showFrame(set, Math.min(P.shown.i, set.frames.length - 1));
    } catch (e) {
      OD.setStatus(`Greeks frames failed: ${e.message}`, true);
      clearShown(); // back to the normal chart, not frames for inputs that are gone
    }
    if (P.again) refreshShown();
  }

  // ------------------------------------------------------------------ playback
  /** Shows one frame of a set. The set is kept, not looked up, so a reprice mid-play cannot swap it. */
  function showFrame(set, i) {
    const same = P.shown && P.shown.set === set && P.shown.i === i;
    P.note = '';
    P.shown = { set, i };
    setProp(P.ui.scrub, 'value', String(i));
    paint();
    if (!same) OD.redrawChart(); // a pricing run has just drawn this frame; no second render
  }

  const clearShown = () => { if (P.shown) { P.shown = null; paint(); if (greekView()) OD.redrawChart(); } };
  /** A new playId makes a running play() loop return at its next tick. */
  const stop = () => { if (P.playing) { P.playId++; P.playing = false; paint(); } };
  const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

  async function play() {
    if (P.playing) return;
    const id = ++P.playId;
    P.playing = true;
    P.note = '';
    paint();
    try {
      const set = await pricedFrames();
      if (!set || id !== P.playId) return;
      const n = set.frames.length, t0 = performance.now();
      // Frames follow the clock, so a slow redraw skips frames rather than stretching the 4 s
      for (;;) {
        const i = frameAtElapsed(performance.now() - t0, n, PLAY_MS);
        showFrame(set, i);
        if (i === n - 1) break;
        await sleep(PLAY_MS / (n - 1));
        if (id !== P.playId) return;
      }
    } catch (e) {
      OD.setStatus(`Greeks animation failed: ${e.message}`, true);
    } finally {
      if (id === P.playId) { P.playing = false; paint(); }
    }
    refreshShown(); // catch up with anything Live moved while playing
  }

  /** If the inputs moved while the frames were priced, they are priced once more rather than shown. */
  async function onScrub(retried = false) {
    P.note = '';
    const set = await pricedFrames();
    if (!set || P.playing || !greekView()) return; // a view switch mid-request shows nothing later
    const pl = plan();
    if (pl.ok && pl.key !== set.key && !retried) { onScrub(true); return; }
    if (pl.ok && pl.key === set.key) showFrame(set, Math.min(+P.ui.scrub.value, set.frames.length - 1));
    refreshShown();
  }

  // ------------------------------------------------------------------ chart hook
  function timeCurves(R, set) {
    if (P.merged && P.merged.R === R && P.merged.set === set) return P.merged;
    const ts = set.frames.map((f) => daysAt(f.ms));
    const curve = Object.fromEntries(KEYS.map((k) => [k,
      mergeCurve(R.times, R.grid[k].map((row) => row[R.spot_index]), ts, set.frames.map((f) => f.atSpot[k]))]));
    const ranges = Object.fromEntries(KEYS.map((k) => [k, yRange([curve[k].y])]));
    // Hover labels once per curve, not on every frame: each one formats a date, and play redraws 10×/s
    const labels = curve[KEYS[0]].x.map((t) => OD.tLabel(t, true));
    P.merged = { R, set, curve, ranges, labels };
    return P.merged;
  }

  OD.greekFrame = () => {
    const R = OD.result();
    if (!P.shown || !R || !greekView()) return null;
    const { set, i } = P.shown;
    const f = set.frames[i];
    const time = timeCurves(R, set);
    return { t: daysAt(f.ms), x: f.x, byPrice: f.byPrice, atSpot: f.atSpot, ref: i > 0 ? set.frames[0].byPrice : null,
      from: daysAt(set.fromMs), to: daysAt(set.toMs), priceRanges: set.priceRanges, curve: time.curve,
      curveLabels: time.labels, timeRanges: time.ranges };
  };

  // ------------------------------------------------------------------ controls
  function setSel(next) {
    if (next === S.greekPlay) return;
    stop(); clearShown(); // the frames were for the old span
    S.greekPlay = next;
    OD.changed(false); // saves; the reprice it starts is cheap and keeps the defaults current
  }

  function onPick(which) {
    const R = OD.result();
    const { date, time } = P.ui[which];
    if (!R || !date.value || !time.value) return;
    const [h, m] = time.value.split(':').map(Number);
    const out = applyPick(S.greekPlay, which, K.nyToMs(date.value, h * 60 + m), Date.now(), lastDays(R));
    P.note = out.error;
    setSel(out.sel);
    paint();
  }

  /** Shows the ends play will use, defaults included, in New York time. */
  function paintPickers(R, pl) {
    if (!num(pl.fromMs)) return;
    const now = Date.now();
    const first = K.nyParts(now).day;
    const last = K.nyParts(now + lastDays(R) * DAY_MS).day;
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    [['from', pl.fromMs], ['to', pl.toMs]].forEach(([which, ms]) => {
      const { date, time } = P.ui[which];
      const at = K.nyParts(ms);
      setProp(date, 'min', first); setProp(date, 'max', last);
      setIdle(date, at.day);
      setIdle(time, hhmm(at.minutes));
    });
  }

  function labelText(pl) {
    if (P.note) return P.note;
    if (P.shown) return `${P.shown.i + 1}/${P.shown.set.frames.length} · ${frameLabel(P.shown)}`;
    if (!pl.ok) return pl.reason;
    return `${FRAMES} frames · ${OD.tLabel(pl.from, true)} → ${OD.tLabel(pl.to, true)}`;
  }

  function paint() {
    const { bar, play: btn, scrub, clear, label } = P.ui;
    setProp(bar, 'hidden', !greekView());
    if (!greekView()) return;
    const R = OD.result();
    const pl = plan();
    if (R) paintPickers(R, pl);
    setProp(btn, 'disabled', !pl.ok || P.playing);
    setProp(btn, 'textContent', P.playing ? 'Playing…' : '▶ Play');
    setProp(btn, 'title', pl.ok ? `Play ${FRAMES} frames from From to To` : pl.reason);
    setProp(scrub, 'disabled', !pl.ok || P.playing);
    setProp(clear, 'disabled', !P.shown || P.playing);
    if (!P.shown) setProp(scrub, 'value', '0');
    scrub.setAttribute('aria-valuetext', P.shown ? frameLabel(P.shown) : pl.ok ? OD.tLabel(pl.from, true) : '');
    setProp(label, 'textContent', labelText(pl));
    setProp(label, 'className', `glabel${P.note || !pl.ok ? ' err' : ''}`);
  }

  // ------------------------------------------------------------------ hooks into the page
  function onRun() {
    const R = OD.result();
    if (R && lastDays(R) > 0) {
      const clean = cleanSel(S.greekPlay, Date.now(), lastDays(R));
      if (clean !== S.greekPlay) S.greekPlay = clean; // saved with the next change
    }
    const key = legsKey();
    if (key !== P.legsKey) { P.legsKey = key; stop(); }
    paint();
    refreshShown();
  }

  function onView(view) {
    stop();
    if (!GREEK_VIEWS.has(view)) P.shown = null;
    paint();
  }

  const STYLE = `
    .gplay { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 14px; border-top: 1px solid var(--line); }
    .gplay[hidden] { display: none; }
    .gplay .pick { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .gplay .pick > span { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .gplay input[type=date], .gplay input[type=time] { height: 24px; padding: 0 5px; background: var(--bg);
      border: 1px solid var(--line-2); border-radius: 5px; font-family: var(--mono); font-size: 11.5px; }
    .gplay input[type=date] { width: 124px; } .gplay input[type=time] { width: 92px; }
    .gplay input:focus { outline: none; border-color: var(--accent); }
    .gplay .run { display: flex; align-items: center; gap: 10px; flex: 1 1 260px; min-width: 0; }
    .gplay .run input[type=range] { flex: 1; min-width: 80px; }
    .gplay .glabel { font: 11.5px var(--mono); color: var(--text); } .gplay .glabel.err { color: var(--neg); }`;

  function picker(which, label, chipText, chipLabel) {
    const date = el('input', { type: 'date', onchange: () => onPick(which), onblur: paint });
    const time = el('input', { type: 'time', step: '60', onchange: () => onPick(which), onblur: paint });
    [date, time].forEach((n) => n.setAttribute('aria-label', `${label} ${n.type} in New York`));
    const chip = el('button', { className: 'chip', textContent: chipText, title: chipLabel,
      onclick: () => { P.note = ''; setSel({ ...S.greekPlay, [which]: null }); paint(); } });
    chip.setAttribute('aria-label', chipLabel);
    P.ui[which] = { date, time };
    return el('div', { className: 'pick' }, el('span', { textContent: label }), date, time, chip);
  }

  function build() {
    const ui = P.ui;
    ui.play = el('button', { className: 'btn', textContent: '▶ Play', onclick: play });
    ui.scrub = el('input', { type: 'range', min: '0', max: String(FRAMES - 1), value: '0', step: '1', oninput: () => onScrub() });
    ui.scrub.setAttribute('aria-label', 'Animation frame, From to To');
    ui.clear = el('button', { className: 'chip', textContent: 'Clear', title: 'Back to the selected date',
      onclick: () => { stop(); clearShown(); } });
    ui.label = el('span', { className: 'glabel' });
    ui.label.setAttribute('aria-live', 'polite');
    ui.bar = el('div', { className: 'gplay', hidden: true },
      picker('from', 'From', 'Now', 'Start now'),
      picker('to', 'To', 'Expiry', 'End at first expiry, just before it settles'),
      el('div', { className: 'run' }, ui.play, ui.scrub, ui.clear),
      ui.label);
    document.getElementById('chart').after(ui.bar);
  }

  document.head.append(el('style', { textContent: STYLE }));
  build();
  const priorRun = OD.afterRun; // earnpanel.js's hook: both run after every pricing reply
  OD.afterRun = () => { try { priorRun(); } finally { onRun(); } };
  OD.onView = onView;
  onRun();
})(globalThis);
