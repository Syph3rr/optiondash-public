// Pure helpers for the dashboard controls: New York time, stepping, default multipliers.
// Loaded in the browser as window.ODControls and in Node tests through module.exports.
(function (root) {
  const NY = 'America/New_York';
  const DAY_MS = 86400000;
  const LAST_SLOT = 23 * 60 + 45;
  const SLOT = 15;

  /** @returns {Object<string,string>} calendar fields of an instant in a time zone */
  function fields(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ms);
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  }

  /** @returns {{day: string, minutes: number}} New York day (YYYY-MM-DD) and minute of day */
  function nyParts(ms) {
    const f = fields(ms, NY);
    return { day: `${f.year}-${f.month}-${f.day}`, minutes: +f.hour * 60 + +f.minute };
  }

  function nyOffsetMs(ms) {
    const f = fields(ms, NY);
    const wall = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute);
    return wall - Math.floor(ms / 60000) * 60000;
  }

  /** @returns {number} the instant of a New York day and minute of day */
  function nyToMs(day, minutes) {
    const [y, m, d] = day.split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d, 0, minutes);
    const first = wall - nyOffsetMs(wall);
    return wall - nyOffsetMs(first);
  }

  /** @returns {string[]} every New York day from start to end, inclusive */
  function dayList(startMs, endMs) {
    const last = nyParts(endMs).day;
    const [y, m, d] = nyParts(startMs).day.split('-').map(Number);
    const days = [];
    for (let i = 0; ; i++) {
      const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
      if (day > last) return days;
      days.push(day);
    }
  }

  /** @returns {{min: number, max: number}} reachable minutes of a day, on 15-minute slots */
  function dayWindow(day, nowMs, endMs) {
    const now = nyParts(nowMs);
    const end = nyParts(endMs);
    return {
      min: day === now.day ? Math.floor(now.minutes / SLOT) * SLOT : 0,
      max: day === end.day ? Math.ceil(end.minutes / SLOT) * SLOT : LAST_SLOT,
    };
  }

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /**
   * A selection is {tSel, tPin}: an absolute timestamp, or an index into the leg expiries.
   * A pin stays on the expiry as the clock moves; both null means "now".
   * @returns {number} days from now
   */
  function selectionDays(sel, expiries, nowMs) {
    if (sel.tPin != null && expiries[sel.tPin] !== undefined) return expiries[sel.tPin];
    return sel.tSel == null ? 0 : Math.max(0, (sel.tSel - nowMs) / DAY_MS);
  }

  /** @returns {number} the selected instant, always inside now..last expiry */
  function selectionMs(sel, expiries, nowMs, lastDays) {
    const days = Math.min(selectionDays(sel, expiries, nowMs), lastDays);
    return sel.tPin == null && sel.tSel != null && days > 0 ? sel.tSel : nowMs + days * DAY_MS;
  }

  /** @returns {{tSel: number|null, tPin: number|null}} the selection, made valid for the reply */
  function normaliseSelection(sel, expiries, lastDays, nowMs) {
    const tPin = sel.tPin != null && expiries[sel.tPin] !== undefined ? sel.tPin : null;
    if (sel.tSel == null || sel.tSel <= nowMs) return { tSel: null, tPin };
    return { tSel: Math.min(sel.tSel, nowMs + lastDays * DAY_MS), tPin };
  }

  /** @returns {number} the next 15-minute slot, passing through clock changes in real time */
  function stepMs(ms, dir) {
    const { day, minutes } = nyParts(ms);
    const slot = dir > 0 ? Math.floor(minutes / SLOT) + 1 : Math.ceil(minutes / SLOT) - 1;
    const next = nyToMs(day, slot * SLOT);
    const moved = (next - ms) * dir;
    return moved > 0 && moved <= SLOT * 60000 ? next : ms + dir * SLOT * 60000;
  }

  /** @returns {number|null} the next expiry after t, wrapping to the first */
  function nextExpiry(t, expiries) {
    if (!expiries.length) return null;
    const later = expiries.find((e) => e > t + 1e-6);
    return later === undefined ? expiries[0] : later;
  }

  /** @returns {number|null} v on the step grid and in bounds; null if v is not a number */
  function snap(v, step, lo, hi) {
    if (v === '' || v === null || !Number.isFinite(+v)) return null;
    const decimals = (String(step).split('.')[1] || '').length;
    return clamp(+(Math.round(+v / step) * step).toFixed(decimals), lo, hi);
  }

  const wheelDir = (deltaY) => (deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0);

  function dayTime(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ms);
    const f = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${f.weekday} ${f.day} ${f.month} ${f.hour}:${f.minute}`;
  }

  /** @returns {{ny: string, local: string}} one instant in New York and viewer time */
  const labels = (ms, localZone) => ({ ny: `${dayTime(ms, NY)} ET`, local: dayTime(ms, localZone) });

  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const joinUnits = (big, small) => (small ? `${big} ${small}` : big);

  /** Whole minutes under an hour; 5-minute steps under 10 hours; whole hours after that. */
  function spanText(mins) {
    const whole = Math.round(mins);
    if (whole < 60) return `${whole} min`;
    const five = Math.round(mins / 5) * 5;
    if (five < 600) return joinUnits(count(Math.floor(five / 60), 'hr', 'hrs'), five % 60 ? `${five % 60} min` : '');
    const hrs = Math.round(mins / 60); // rounding first carries 23 hrs 58 min into a whole day
    if (hrs < 24) return count(hrs, 'hr', 'hrs');
    return joinUnits(count(Math.floor(hrs / 24), 'day', 'days'), hrs % 24 ? count(hrs % 24, 'hr', 'hrs') : '');
  }

  /** @returns {string} time from now in plain words: 'now', 'in 45 min', 'in 3 days 22 hrs' */
  function aheadText(days) {
    const mins = days * 1440;
    return mins >= 1 ? `in ${spanText(mins)}` : 'now'; // the selection never lies in the past
  }

  function wall(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ms);
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  }

  /** The viewer's clock, with the weekday only when their day is not New York's. */
  function localText(ms, localZone) {
    const ny = wall(ms, NY), here = wall(ms, localZone);
    const sameDay = ny.year === here.year && ny.month === here.month && ny.day === here.day;
    if (sameDay && ny.hour === here.hour && ny.minute === here.minute) return ''; // already on New York time
    return `${sameDay ? '' : `${here.weekday} `}${here.hour}:${here.minute} your time`;
  }

  /**
   * @returns {{short: string, main: string, local: string}} labels for an instant `days` from now:
   * short for tight spots, main for titles, local as a lighter extra ('' on New York time)
   */
  function whenParts(days, nowMs, localZone) {
    // Nearest minute, so an expiry worked out in fractional days reads 16:00, not 15:59
    const ms = Math.round((nowMs + days * DAY_MS) / 60000) * 60000;
    const f = wall(ms, NY);
    const ny = `${f.weekday} ${f.day} ${f.month.slice(0, 3)}, ${f.hour}:${f.minute} ET`;
    const ahead = aheadText(days);
    const local = localText(ms, localZone);
    return ahead === 'now' ? { short: 'now', main: `Now · ${ny}`, local } : { short: ny, main: `${ny} · ${ahead}`, local };
  }

  /** @returns {string} DTE for a box: 2 decimals, or 4 under a day, with no padding */
  const dteText = (dte) => String(+dte.toFixed(dte < 1 ? 4 : 2));

  function defaultMultiplier(kind, model) {
    if (kind !== 'stock') return 100;
    return model === 'futures' ? 50 : 1;
  }

  function multiplierOnKindChange(prevKind, nextKind, current, model) {
    const crossed = (prevKind === 'stock') !== (nextKind === 'stock');
    return crossed ? defaultMultiplier(nextKind, model) : current;
  }

  const api = {
    DAY_MS, SLOT, nyParts, nyToMs, dayList, dayWindow, clamp, nextExpiry, snap, wheelDir, labels,
    selectionDays, selectionMs, normaliseSelection, stepMs, defaultMultiplier, multiplierOnKindChange,
    dteText, aheadText, whenParts,
  };
  root.ODControls = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
