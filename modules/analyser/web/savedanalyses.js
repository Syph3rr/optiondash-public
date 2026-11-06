// Saved analyses: the analyser state as a versioned JSON blob, and the journal API that stores it.
// Pure helpers (no DOM). fetch is passed in, so Node tests can use a fake.
// Loaded in the browser as window.ODSaved and in Node tests through module.exports.
//
// A blob is untrusted on the way back in (it went through a server and a database), and
// index.html writes leg numbers into its own innerHTML, so restore() rebuilds every field
// from checked values and never copies an object across as it came.
//
// Gateway asset entry (src/assets.rs, ANALYSER table):
//   asset!("savedanalyses.js", JS, "../modules/analyser/web/savedanalyses.js"),
(function (root) {
  'use strict';

  const VERSION = 1;
  const NAME_MAX = 80;
  const BASE = '/api/journal/analyses';
  const MODELS = ['european', 'futures', 'american'];
  const VIEWS = ['payoff', 'heat', 'gprice', 'gtime'];
  const KINDS = ['call', 'put', 'stock'];
  const SOURCES = ['manual', 'live'];
  const SCALARS = ['symbol', 'spot', 'model', 'rate', 'divy', 'pdte', 'ivShift', 'range', 'rangeAuto',
    'view', 'tSel', 'priceSource'];
  const DEFAULTS = { symbol: 'SPX', spot: 5800, model: 'european', rate: 4.0, divy: 1.3, pdte: 30,
    ivShift: 0, range: 15, rangeAuto: true, view: 'payoff', tSel: null, priceSource: 'manual' };
  const EXPIRY_RE = /^\d{8}$/;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SYMBOL_RE = /^[A-Za-z0-9.^\- ]{1,20}$/;

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const pos = (x) => num(x) && x > 0;
  const oneOf = (list) => (x) => list.includes(x);
  const text = (x, max = 40) => typeof x === 'string' && x.length > 0 && x.length <= max;
  const pick = (x, ok, fallback) => (ok(x) ? x : fallback);
  const orNull = (x, ok) => (ok(x) ? x : null);

  /** Checks applied to each top-level field on the way back in. */
  const SCALAR_OK = {
    symbol: (x) => typeof x === 'string' && SYMBOL_RE.test(x), spot: pos, model: oneOf(MODELS),
    rate: num, divy: num, pdte: (x) => num(x) && x >= 0, ivShift: (x) => num(x) && x >= -20 && x <= 20,
    range: (x) => num(x) && x >= 0.5 && x <= 60, rangeAuto: (x) => typeof x === 'boolean',
    view: oneOf(VIEWS), tSel: (x) => x === null || pos(x), priceSource: oneOf(SOURCES),
  };

  // ------------------------------------------------------------------ serialise
  const contractOf = (c) => (c && typeof c === 'object' ? {
    symbol: c.symbol, expiry: c.expiry, strike: c.strike ?? null, right: c.right ?? null,
    trading_class: c.trading_class } : null);

  function legOut(l) {
    return { enabled: !!l.enabled, kind: l.kind, long: !!l.long, qty: l.qty, strike: l.strike, dte: l.dte,
      iv: l.iv, premium: l.premium ?? null, fill: l.fill ?? null, multiplier: l.multiplier,
      live: contractOf(l.live), listed: contractOf(l.listed), ivOverride: !!l.ivOverride };
  }

  const entryOut = (e) => ({ date: (e && e.date) || null, spot: (e && e.spot) ?? null, iv: (e && e.iv) ?? null });

  /** @returns {object} a plain, versioned copy of what defines the analysis (no ids, no pins) */
  function serialise(S) {
    const out = { v: VERSION };
    SCALARS.forEach((k) => { if (S[k] !== undefined) out[k] = S[k]; });
    return { ...out, entry: entryOut(S.entry), legs: (S.legs || []).map(legOut) };
  }

  // ------------------------------------------------------------------ restore
  function contractIn(c, needsStrike) {
    if (!c || typeof c !== 'object') return null;
    if (!text(c.symbol, 20) || !EXPIRY_RE.test(c.expiry) || !text(c.trading_class, 20)) return null;
    const base = { symbol: c.symbol, expiry: c.expiry, trading_class: c.trading_class };
    if (!needsStrike) return base;
    if (!pos(c.strike) || (c.right !== 'C' && c.right !== 'P')) return null;
    return { symbol: c.symbol, expiry: c.expiry, strike: c.strike, right: c.right, trading_class: c.trading_class };
  }

  /** @returns {object|null} a leg built only from checked values; null drops a damaged leg */
  function legIn(l) {
    if (!l || typeof l !== 'object' || !KINDS.includes(l.kind)) return null;
    const stock = l.kind === 'stock';
    if (!pos(l.qty) || !pos(l.multiplier)) return null;
    if (!stock && !(pos(l.strike) && num(l.dte) && l.dte >= 0 && pos(l.iv))) return null;
    const live = stock ? null : contractIn(l.live, true);
    return {
      enabled: l.enabled !== false, kind: l.kind, long: l.long !== false, qty: l.qty,
      strike: stock ? 0 : l.strike, dte: stock ? 0 : l.dte, iv: pick(l.iv, pos, 18),
      premium: orNull(l.premium, num), fill: orNull(l.fill, (x) => num(x) && x >= 0),
      multiplier: l.multiplier, live, listed: stock ? null : contractIn(l.listed, false),
      ivOverride: l.ivOverride === true,
    };
  }

  function entryIn(e) {
    const src = e && typeof e === 'object' ? e : {};
    return { date: orNull(src.date, (x) => typeof x === 'string' && DAY_RE.test(x)),
      spot: orNull(src.spot, pos), iv: orNull(src.iv, pos) };
  }

  /**
   * The analyser state a saved blob describes. Missing or damaged fields fall back to the defaults.
   * @returns {{state: object, dropped: number}} dropped = legs that could not be read
   * @throws {Error} for anything that is not a v1 blob
   */
  function restore(blob) {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) throw new Error('saved analysis is not readable');
    if (num(blob.v) && blob.v > VERSION) throw new Error('saved by a newer version of OptionDash; update to load it');
    const state = {};
    SCALARS.forEach((k) => { state[k] = pick(blob[k], SCALAR_OK[k], DEFAULTS[k]); });
    const raw = Array.isArray(blob.legs) ? blob.legs : [];
    const legs = raw.map(legIn).filter(Boolean);
    return { state: { ...state, entry: entryIn(blob.entry), legs }, dropped: raw.length - legs.length };
  }

  // ------------------------------------------------------------------ names
  /** @returns {string|null} why the name cannot be used, or null when it can */
  function nameProblem(name) {
    const n = String(name ?? '').trim();
    if (!n) return 'Give the analysis a name';
    if (n.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters`;
    if ([...n].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return 'The name has a control character';
    return null;
  }

  /** A starting name: symbol, then the date in New York, e.g. "SPX 5 Nov 2026". */
  function suggestName(S, nowMs) {
    const day = new Date(nowMs).toLocaleDateString('en-AU', { timeZone: 'America/New_York',
      day: 'numeric', month: 'short', year: 'numeric' });
    return `${String(S.symbol || 'Analysis').toUpperCase()} ${day}`.slice(0, NAME_MAX);
  }

  /** The list's option text: name · underlying · last saved day. */
  function optionText(row) {
    const parts = [row.name];
    if (row.underlying) parts.push(row.underlying);
    if (typeof row.updated_at === 'string') parts.push(row.updated_at.slice(0, 10));
    return parts.join(' · ');
  }

  // ------------------------------------------------------------------ api
  async function call(fetchFn, path, method = 'GET', body) {
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetchFn(path, init); } catch (e) { throw new Error('the journal is not reachable'); }
    const j = await res.json().catch(() => null);
    if (res.ok && j && j.ok) return j.data;
    const offline = res.status === 502 || res.status === 503;
    throw new Error((j && j.error) || (offline ? 'the journal is offline' : `request failed (${res.status})`));
  }

  const idPath = (id) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error('no saved analysis selected');
    return `${BASE}/${id}`;
  };

  const api = (fetchFn) => ({
    list: () => call(fetchFn, BASE),
    get: async (id) => call(fetchFn, idPath(id)),
    create: (name, state) => call(fetchFn, BASE, 'POST', { name: String(name).trim(), state }),
    update: async (id, name, state) => call(fetchFn, idPath(id), 'PUT', { name: String(name).trim(), state }),
    remove: async (id) => call(fetchFn, idPath(id), 'DELETE'),
  });

  const out = { VERSION, NAME_MAX, BASE, DEFAULTS, serialise, restore, nameProblem, suggestName, optionText, api };
  root.ODSaved = out;
  if (typeof module !== 'undefined') module.exports = out;
})(typeof window !== 'undefined' ? window : globalThis);
