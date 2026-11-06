// Earnings: how a position looks after the report, once the IV the report carried has gone.
// Pure model, loaded in the browser as window.ODEarnings and in Node tests through module.exports.
// The panel and the chart overlay are in earnpanel.js.
//
// The model: every expiry after the report holds the same one-off event variance on top of the
// stock's normal vol. Two such expiries give both: the forward vol between them is the normal vol,
// and whatever the front holds above it is the event. After the report each leg keeps only its
// normal part, so the front falls far more than the back. IV is a percent and DTE is days.
(function (root) {
  'use strict';
  const K = root.ODControls;
  const YEAR = 365;
  const DTE_EPS = 1e-6;
  // An expiry this close to the report settles with it, not after it: leg DTEs are read a moment
  // before the report time is, so a 16:00 expiry on an after-close report day reads a hair later.
  const AFTER_EPS = 1 / 1440;
  const NOISY_GAP = 2;           // days; closer expiries make the forward vol a noisy estimate
  const MIN_IV = 0.5;            // percent; the engine's floor
  const OPEN = 9 * 60 + 30;      // 09:30 New York: a report before the open lands here
  const CLOSE = 16 * 60;         // 16:00 New York: a report after the close lands here
  const SETTLED = 10 * 60;       // 10:00 New York: "after" is once the first half hour has traded
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const isOption = (l) => l.kind === 'call' || l.kind === 'put';
  /** @returns {boolean} true when the leg is still open once the report is out */
  const carriesReport = (l, eventDays) => num(l.dte) && l.dte > eventDays + AFTER_EPS;

  /** @returns {string} the next Monday-to-Friday after a YYYY-MM-DD day (holidays not known) */
  function nextWeekday(day) {
    const [y, m, d] = day.split('-').map(Number);
    for (let i = 1; ; i++) {
      const next = new Date(Date.UTC(y, m - 1, d + i));
      if (next.getUTCDay() % 6 !== 0) return next.toISOString().slice(0, 10);
    }
  }

  /**
   * When the report lands and when "after" is, in days from nowMs. Unknown timing counts as after
   * the close, the usual case. @returns {{eventDays, afterDays, afterMs}|null} null for a bad date
   * or a report that is already out
   */
  function eventTimes(day, when, nowMs) {
    if (typeof day !== 'string' || !DATE_RE.test(day)) return null;
    const before = when === 'bmo';
    const eventMs = K.nyToMs(day, before ? OPEN : CLOSE);
    const afterMs = K.nyToMs(before ? day : nextWeekday(day), SETTLED);
    // A report already out is in today's IVs: there is nothing left to crush.
    if (!num(eventMs) || eventMs <= nowMs) return null;
    return { eventDays: (eventMs - nowMs) / K.DAY_MS, afterDays: (afterMs - nowMs) / K.DAY_MS, afterMs };
  }

  const priced = (l) => l.enabled && isOption(l) && l.qty > 0 && num(l.dte) && num(l.iv) && l.iv > 0;

  /** @returns {{dte: number, iv: number}[]} each expiry after the report, IV pooled by variance */
  function expiriesAfter(legs, eventDays) {
    const sorted = legs.filter((l) => priced(l) && carriesReport(l, eventDays)).sort((a, b) => a.dte - b.dte);
    const groups = sorted.reduce((out, l) => {
      const last = out[out.length - 1];
      return last && Math.abs(last[0].dte - l.dte) <= DTE_EPS ? [...out.slice(0, -1), [...last, l]] : [...out, [l]];
    }, []);
    return groups.map((g) => ({ dte: g[0].dte, iv: Math.sqrt(g.reduce((s, l) => s + l.iv * l.iv, 0) / g.length) }));
  }

  /**
   * @returns {{ok: true, baseIv: number, eventVar: number, move: number, front: object, back: object,
   *   note?: string} | {ok: false, reason: string}} baseIv and move in percent; eventVar is the
   *   report's total variance (σ² × years), so √eventVar is the 1σ move as a fraction
   */
  function eventModel(legs, eventDays) {
    const after = expiriesAfter(legs, eventDays);
    if (after.length < 2) return { ok: false, reason: 'needs legs on two expiries after the report' };
    const [front, back] = after;
    const v = (e) => (e.iv / 100) ** 2;
    const baseVar = (v(back) * back.dte - v(front) * front.dte) / (back.dte - front.dte);
    if (!(baseVar > 0)) return { ok: false, reason: 'the back expiry has less total variance than the front' };
    const eventVar = Math.max(0, (v(front) - baseVar) * front.dte / YEAR);
    const notes = [
      ...(eventVar > 0 ? [] : ['no earnings premium in these IVs: front is not above normal vol']),
      ...(back.dte - front.dte < NOISY_GAP ? ['expiries under 2 days apart make this estimate noisy'] : []),
    ];
    const model = { ok: true, baseIv: Math.sqrt(baseVar) * 100, eventVar, move: Math.sqrt(eventVar) * 100, front, back };
    return notes.length ? { ...model, note: notes.join('; ') } : model;
  }

  /** @returns {number} the leg's IV in percent once the report is out */
  function ivAfter(leg, model, eventDays) {
    if (!isOption(leg) || !model.ok || !carriesReport(leg, eventDays) || !model.eventVar) return leg.iv;
    const left = (leg.iv / 100) ** 2 - model.eventVar * YEAR / leg.dte;
    return Math.max(MIN_IV, Math.sqrt(Math.max(left, 0)) * 100);
  }

  /**
   * Legs to price after the report: each IV from the model unless an IV after was typed, and a
   * blank premium pinned to today's entry, or the crushed IV would re-base the P&L to zero.
   * @param {(number|null)[]} entries today's entry price per leg, from the last pricing reply
   */
  const afterLegs = (legs, model, eventDays, entries) => legs.map((l, i) => ({
    ...l,
    iv: num(l.ivAfter) && l.ivAfter > 0 && carriesReport(l, eventDays) ? l.ivAfter : ivAfter(l, model, eventDays),
    premium: l.premium ?? (num(entries[i]) ? entries[i] : null),
  }));

  /** A step p (0..1) from today's IVs to the after-report ones, blended in variance. */
  const frameLegs = (from, to, p) => from.map((l, i) => ({
    ...l, iv: Math.sqrt((1 - p) * l.iv * l.iv + p * to[i].iv * to[i].iv),
  }));

  const api = { eventTimes, eventModel, ivAfter, afterLegs, frameLegs, nextWeekday, carriesReport };
  root.ODEarnings = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
