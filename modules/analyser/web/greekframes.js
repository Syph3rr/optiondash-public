// Pure helpers for the Greeks animation (greekplay.js): frame times, reply lookup, fixed y ranges,
// From/To rules and the cache key. Loaded in the browser as window.ODGreekFrames and in Node tests
// through module.exports. New York time comes from window.ODControls (controls.js).
(function (root) {
  'use strict';
  const FRAMES = 40;
  const DAY_MS = 86400000;
  const SNAP_MS = 60000;          // a pick within a minute of now means "now"
  const MIN_SPAN_DAYS = 1 / 1440; // a minute: anything shorter has nothing to play
  const PAD = 0.06;               // y padding, as a share of the range
  const CLOSE = 960;              // 16:00 New York
  const EARLY_MS = 30 * 60000;

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /** @returns {number[]} n evenly spaced times; the ends are exactly from and to */
  function frameTimes(from, to, n = FRAMES) {
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? to : from + (to - from) * i / (n - 1)));
  }

  /** @returns {number[]} the index of each wanted time in times, or -1 when it is not there */
  const frameIndexes = (times, wanted, tol = 1e-6) =>
    wanted.map((w) => times.findIndex((t) => Math.abs(t - w) <= tol));

  /** @returns {number[]|null} [lo, hi] over every finite value of every series, padded */
  function yRange(series, pad = PAD) {
    const vals = series.flatMap((s) => (s || []).filter(num));
    if (!vals.length) return null;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    // A flat line (a greek that is 0 everywhere) still needs a visible axis
    const p = hi - lo > 1e-12 ? (hi - lo) * pad : Math.max(Math.abs(hi) * 0.1, 1e-6);
    return [lo - p, hi + p];
  }

  /** @returns {Object<string,number[]|null>} one fixed y range per greek, over all frames */
  const priceRanges = (frames, keys) =>
    Object.fromEntries(keys.map((k) => [k, yRange(frames.map((f) => f.byPrice[k]))]));

  /** @returns {object} one time row of the reply: each greek across prices and at spot, and the
   *  instant it stands for, so its label never drifts as the clock moves */
  function frameAt(reply, i, keys, pricedAtMs) {
    const j = reply.spot_index;
    return {
      t: reply.times[i], ms: pricedAtMs + reply.times[i] * DAY_MS, x: reply.prices,
      byPrice: Object.fromEntries(keys.map((k) => [k, reply.grid[k][i]])),
      atSpot: Object.fromEntries(keys.map((k) => [k, reply.grid[k][i][j]])),
    };
  }

  /** The Greeks × Time curve with the frame points added, so the playhead sits on the line between
   *  the coarse grid points. @returns {{x: number[], y: number[]}} */
  function mergeCurve(xa, ya, xb, yb, tol = 1e-6) {
    const grid = xa.map((x, i) => [x, ya[i]]).filter(([x]) => !xb.some((b) => Math.abs(b - x) <= tol));
    const pts = [...grid, ...xb.map((x, i) => [x, yb[i]])].sort((p, q) => p[0] - q[0]);
    return { x: pts.map((p) => p[0]), y: pts.map((p) => p[1]) };
  }

  /** From and To in days from now. Blank From is now and blank To is the first expiry, so they follow
   *  the clock and the legs. @returns {{ok: boolean, from?: number, to?: number, reason?: string}} */
  function playSpan(sel, nowMs, firstExpiry, lastDays) {
    if (!(lastDays > 0)) return { ok: false, reason: 'add an option leg to animate the Greeks' };
    const endMs = nowMs + lastDays * DAY_MS;
    const fromMs = sel && num(sel.from) ? clamp(sel.from, nowMs, endMs) : nowMs;
    const expiryMs = nowMs + clamp(num(firstExpiry) ? firstExpiry : lastDays, 0, lastDays) * DAY_MS;
    const toMs = clamp(sel && num(sel.to) ? sel.to : defaultToMs(expiryMs, fromMs), nowMs, endMs);
    const out = { from: (fromMs - nowMs) / DAY_MS, to: (toMs - nowMs) / DAY_MS, fromMs, toMs };
    return out.to - out.from < MIN_SPAN_DAYS ? { ok: false, ...out, reason: 'From must be before To' } : { ok: true, ...out };
  }

  /** @returns {string} the weekday before a New York day (YYYY-MM-DD); holidays are not known */
  function prevWeekday(day) {
    const [y, m, d] = day.split('-').map(Number);
    const back = (n) => new Date(Date.UTC(y, m - 1, d - n));
    const n = [1, 2, 3].find((k) => ![0, 6].includes(back(k).getUTCDay()));
    return back(n).toISOString().slice(0, 10);
  }

  /** The default end of play: the close the weekday before expiry day. On expiry day an
   *  at-the-money leg's theta and gamma climb many times over (theta grows as 1/√time), and with
   *  axes fixed over all frames that would flatten every earlier frame. When From is already on
   *  expiry day, half an hour before the expiry, else the expiry itself.
   *  @returns {number} ms; later than fromMs when it can be */
  function defaultToMs(expiryMs, fromMs) {
    const K = root.ODControls;
    const exp = Math.round(expiryMs / 60000) * 60000; // fractional days: 15:59:59.9 is 16:00
    const dayBefore = K.nyToMs(prevWeekday(K.nyParts(exp).day), CLOSE);
    if (dayBefore > fromMs) return dayBefore;
    const early = exp - EARLY_MS;
    return early > fromMs ? early : exp;
  }

  const inTrade = (ms, nowMs, lastDays) => num(ms) && ms > nowMs + SNAP_MS && ms <= nowMs + lastDays * DAY_MS + SNAP_MS;

  /** @returns {{sel: object, error: string}} the selection with one end picked, or why not */
  function applyPick(sel, which, ms, nowMs, lastDays) {
    if (!num(ms)) return { sel, error: 'enter a date and time' };
    if (ms > nowMs + lastDays * DAY_MS + SNAP_MS) return { sel, error: 'that is past the last expiry' };
    if (ms <= nowMs + SNAP_MS) {
      if (which === 'to') return { sel, error: 'To must be after now' };
      return sel.from === null ? { sel, error: '' } : { sel: { ...sel, from: null }, error: '' };
    }
    return { sel: { ...sel, [which]: ms }, error: '' };
  }

  /** @returns {{from: number|null, to: number|null}} sel itself if still valid, else with stale ends blanked */
  function cleanSel(sel, nowMs, lastDays) {
    const s = sel && typeof sel === 'object' ? sel : {};
    const from = inTrade(s.from, nowMs, lastDays) ? s.from : null;
    const to = inTrade(s.to, nowMs, lastDays) ? s.to : null;
    return from === s.from && to === s.to ? sel : { from, to };
  }

  /** What the frames depend on, rounded so that Live's small ticks do not reprice 40 frames on every
   *  poll. Picked ends count to the minute as instants, so the clock moving does not reprice; blank
   *  ends follow now and the legs, which the body already carries. @returns {string} */
  function frameKey(body, sel) {
    const r = (x, d) => (typeof x === 'number' ? +x.toPrecision(d) : x);
    const minute = (ms) => (num(ms) ? Math.round(ms / 60000) : null);
    const { at_days: _skip, ...rest } = body;
    return JSON.stringify({ ...rest, spot: r(body.spot, 4), range: r(body.range, 3),
      legs: body.legs.map((l) => ({ ...l, iv: r(l.iv, 3), dte: r(l.dte, 3), premium: r(l.premium, 4) })),
      from: minute(sel && sel.from), to: minute(sel && sel.to) });
  }

  /** @returns {number} the frame to show after elapsedMs of a totalMs playback */
  const frameAtElapsed = (elapsedMs, n, totalMs) => clamp(Math.floor(elapsedMs / totalMs * (n - 1)), 0, n - 1);

  const api = { FRAMES, frameTimes, frameIndexes, yRange, priceRanges, frameAt, mergeCurve, playSpan,
    defaultToMs, applyPick, cleanSel, frameKey, frameAtElapsed };
  root.ODGreekFrames = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
