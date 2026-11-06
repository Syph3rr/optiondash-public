// Live market data for the dashboard: Live toggle, source badges, chain panel, Sync, polling.
// The pure helpers are loaded in Node tests through module.exports. The rest needs a page.
//
// Market data is untrusted input. Nothing here uses innerHTML: every outside value reaches the
// DOM through textContent or an element property, and rows are checked before they become legs,
// because index.html writes leg strikes into its own innerHTML.
(function (root) {
  'use strict';
  const R = root.ODRules;
  const P = root.ODSync;
  const { num, contractKey, nearestBy, nearestExpiry, MAX_CONTRACTS } = P;
  const HOLD_MS = 6000;      // how long a market message outlives the pricing status
  const STATUS_MS = 10000;
  const REQUEST_MS = 20000;  // longer than the server's own 15 s limit
  const RETRY_MS = 2000;     // a new contract's stream needs a moment to deliver a first quote
  const DEFAULT_IV = 18;     // the presets' default, for a contract with no usable IV
  const LABELS = new Map([['live', 'LIVE'], ['delayed', 'DELAYED'], ['frozen', 'FROZEN'],
    ['delayed_frozen', 'FROZEN'], ['yahoo', 'YAHOO']]);
  const MODELS = new Set(['european', 'futures', 'american']);
  const EXPIRY_RE = /^\d{8}$/;
  const LEG_CELLS = ['strike', 'iv', 'premium', 'multiplier'];
  const AM_CLASSES = new Set(['SPX', 'NDX', 'RUT']);  // as sidecar/contracts.py
  const AM_SETTLE_MINUTES = 570;  // 09:30 New York
  const PM_SETTLE_MINUTES = 960;  // 16:00 New York
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ------------------------------------------------------------------ pure helpers
  const text = (x) => typeof x === 'string' && x !== '';
  const knownModel = (m) => MODELS.has(m);
  const canConnect = (status) => status.sidecar === 'online' && status.ibkr === 'disconnected';

  /**
   * q.seen is when a successful poll last covered this value. as_of cannot decide staleness: it
   * is hours old for a healthy Yahoo row or a closed market, so it only appears on hover.
   * A mark from the last trade (no bid or ask, as when the market is closed) says so on hover too,
   * so it is never taken for a live mid.
   * @returns {{text: string, stale: boolean, title: string}|null} null with no known data type
   */
  function badge(q, nowMs) {
    const label = q ? LABELS.get(q.data_type) : undefined;
    if (!label) return null;
    const stale = R.isStale(q.seen, nowMs);
    const kind = q.mark_kind === 'last' ? ' · last trade, no live bid/ask' : '';
    return { text: stale ? `${label} STALE` : label, stale, title: `${q.source}${kind} · as of ${q.as_of}` };
  }

  const validRow = (q) => !!q && typeof q === 'object' && num(q.strike) && q.strike > 0
    && (q.right === 'C' || q.right === 'P') && text(q.symbol) && text(q.expiry) && text(q.trading_class);
  const validRows = (rows) => (Array.isArray(rows) ? rows.filter(validRow) : []);

  const validExpiry = (e) => !!e && typeof e === 'object' && EXPIRY_RE.test(e.expiry)
    && text(e.trading_class) && num(e.dte);
  const validExpiries = (list) => (Array.isArray(list) ? list.filter(validExpiry) : []);

  /** @returns {object[]} what to ask for: each contract once, for this symbol only */
  function linkedContracts(legs, symbol) {
    const seen = new Map(legs.filter((l) => l.live && l.live.symbol === symbol)
      .map((l) => [contractKey(l.live), l.live]));
    return [...seen.values()].slice(0, MAX_CONTRACTS);
  }

  /** @returns {object[]} legs after a poll; ODRules.applyQuote matches each quote by contract */
  const refreshLegs = (legs, quotes) =>
    legs.map((l) => quotes.reduce((leg, q) => R.applyQuote(leg, q), l));

  /** @returns {number} days from nowMs to the contract's settlement; NaN for a damaged expiry */
  function settlementDte({ expiry, trading_class: tradingClass }, nowMs) {
    if (!EXPIRY_RE.test(expiry)) return NaN;
    const K = root.ODControls;
    const day = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
    const minutes = AM_CLASSES.has(tradingClass) ? AM_SETTLE_MINUTES : PM_SETTLE_MINUTES;
    return (K.nyToMs(day, minutes) - nowMs) / K.DAY_MS;
  }

  /** An unlinked leg on a picked date follows that date; once it has passed, the date goes too. */
  function ageListed(l, nowMs) {
    const dte = settlementDte(l.listed, nowMs);
    if (!num(dte)) return l;
    return dte > 0 ? { ...l, dte } : { ...l, dte: 0, listed: null };
  }

  /** @returns {object[]} legs brought up to nowMs by the same rule a quote uses, expiry included */
  const ageLegs = (legs, nowMs) => legs.map((l) => {
    if (l.live) return R.applyQuote(l, { ...l.live, dte: settlementDte(l.live, nowMs) });
    return l.listed ? ageListed(l, nowMs) : l;
  });

  /** @returns {string} an expiry's calendar day, e.g. 'Fri 6 Nov 26': the date IBKR lists */
  function expiryDay(expiry) {
    const day = new Date(Date.UTC(+expiry.slice(0, 4), +expiry.slice(4, 6) - 1, +expiry.slice(6, 8)));
    return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${expiry.slice(2, 4)}`;
  }

  const expiryValue = (e) => `${e.expiry}|${e.trading_class}`;

  /**
   * The leg's expiry menu: Custom (a typed DTE), then each listed date with its DTE now. The
   * leg's own date is selected: its contract when linked, else the date picked for it.
   * @returns {{value: string, text: string, selected: boolean}[]}
   */
  function expiryChoices(listed, leg, nowMs) {
    const own = leg.live || leg.listed;
    const mine = own ? expiryValue(own) : '';
    const open = listed.map((e) => ({ e, dte: settlementDte(e, nowMs) })).filter((x) => x.dte > 0);
    const found = open.some(({ e }) => expiryValue(e) === mine);
    const dated = open.map(({ e, dte }) => ({ value: expiryValue(e), selected: expiryValue(e) === mine,
      text: `${expiryDay(e.expiry)} · ${dte.toFixed(1)}d` }));
    return [{ value: '', text: 'Custom DTE', selected: !found }, ...dated];
  }

  const spotFrom = (spot, underlying) => {
    const price = underlying ? underlying.price : null;
    return num(price) && price > 0 ? price : spot;
  };

  const needsRedraw = (before, after) => R.moved(before, after)
    || after.some((l, i) => !l.live && !!before[i].live);

  /** @returns {{strike: number, call: object|null, put: object|null}[]} by ascending strike */
  function chainTable(rows) {
    const byStrike = new Map();
    rows.forEach((q) => {
      const row = byStrike.get(q.strike) || { strike: q.strike, call: null, put: null };
      byStrike.set(q.strike, { ...row, [q.right === 'C' ? 'call' : 'put']: q });
    });
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  }

  const nearestStrike = (table, spot) => {
    const row = nearestBy(table, spot, (r) => r.strike);
    return row ? row.strike : null;
  };

  /** A missing bid or ask shows last, marked so it cannot be mistaken for a live quote. */
  function quoteCell(price, last) {
    if (num(price)) return { text: price.toFixed(2), isLast: false };
    if (num(last)) return { text: `L ${last.toFixed(2)}`, isLast: true };
    return { text: '—', isLast: false };
  }

  function expiryLabel(e) {
    const date = `${e.expiry.slice(0, 4)}-${e.expiry.slice(4, 6)}-${e.expiry.slice(6, 8)}`;
    return `${date} · ${e.trading_class} · ${e.dte.toFixed(1)}d`;
  }

  const chainSources = (rows) =>
    [...new Set(rows.map((q) => LABELS.get(q.data_type)).filter(Boolean))];

  function ageText(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `updated ${seconds}s ago` : `updated ${Math.floor(seconds / 60)}m ago`;
  }

  /** The chain button names what a click does next, so it must follow the panel. */
  const chainFace = (open) => (open
    ? { text: '− From chain', title: 'Hide the option chain' }
    : { text: '+ From chain', title: 'Show the option chain for the symbol, to add legs from listed contracts' });

  /** The TWS connection is shared by every module and owned by the gateway's broker routes;
   *  quotes, chains and the rest stay on /api/market/*. Each page announces a change on
   *  BROKER_EVENT so the nav chip and this page agree, and ignores its own announcement. */
  const BROKER = {
    status: '/api/broker/status', connect: '/api/broker/connect', event: 'broker:changed',
    busy: 'broker:busy', // {source, busy}: while another module connects, ours stays disabled
  };
  const isOwnBrokerEvent = (e) => Boolean(e && e.detail && e.detail.source === 'analyser');

  const api = {
    badge, validRows, validExpiries, linkedContracts, refreshLegs, settlementDte, ageLegs, spotFrom,
    needsRedraw, expiryDay, expiryChoices,
    chainTable, nearestStrike, quoteCell, expiryLabel, chainSources, ageText, knownModel, canConnect,
    chainFace, BROKER, isOwnBrokerEvent,
  };
  root.ODMarket = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------ page state
  const OD = root.OptionDash;
  const S = OD.S;
  const $ = (id) => document.getElementById(id);
  const M = {
    online: false, reason: '', busy: false, syncing: false, failed: false, timer: null,
    canConnect: false, connecting: false, othersBusy: new Set(),
    loadSeq: 0, chainSeq: 0, chainAt: null, underlying: null, expiries: [], listed: [], quotes: new Map(),
    ui: {},
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  const say = (msg, err = false) => OD.setStatus(msg, err, HOLD_MS);

  function failText(e) {
    if (e.status) return e.message;
    return e.name === 'TimeoutError' ? 'market data request timed out' : 'server not reachable';
  }

  const malformed = (status) => Object.assign(new Error('market data reply was malformed'), { status });

  async function request(path, body) {
    const post = body && { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) };
    const res = await fetch(path, { ...post, signal: AbortSignal.timeout(REQUEST_MS) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (data && data.error) || `market data request failed (${res.status})`;
      throw Object.assign(new Error(String(message)), { status: res.status });
    }
    if (data === null) throw malformed(res.status);
    return data;
  }

  /** Keeps network failures apart from bugs: only the request can land in `error`. */
  const attempt = (pending) => pending.then((data) => ({ data }), (error) => ({ error }));

  const priced = (fields) => ({ ...fields, spot: S.spot > 0 ? S.spot : null, rate: S.rate / 100,
    div_yield: S.divy / 100, model: S.model });
  const expiriesPath = (symbol) => `/api/market/expiries/${encodeURIComponent(symbol)}`;
  const strikesPath = (symbol, { expiry, right }) => `/api/market/strikes/${encodeURIComponent(symbol)}`
    + `?expiry=${encodeURIComponent(expiry.expiry)}`
    + `&trading_class=${encodeURIComponent(expiry.trading_class)}&right=${right}`;

  /** Writes new values into the existing leg objects: legs-table closures hold those objects. */
  const assignLegs = (next) => S.legs.forEach((l, i) => Object.assign(l, next[i]));

  function typingInLegs() {
    const active = document.activeElement;
    return !!(active && active.closest && active.closest('#legs'));
  }

  /** Rebuilding the table would take the field out from under someone typing in it. */
  const redrawLegs = () => OD.changed(!typingInLegs());

  /** False once the user has started typing something else in the Symbol box. */
  const boxHolds = (symbol) => $('symbol').value.trim().toUpperCase() === symbol;

  function setSpot(spot) {
    S.spot = spot;
    if (document.activeElement !== $('spot')) $('spot').value = spot;
  }

  // ------------------------------------------------------------------ rendering
  // Writes only what changed: rewriting a node's text or title cuts off an open tooltip.
  const setProp = (node, prop, value) => { if (node[prop] !== value) node[prop] = value; };

  function paintBadge(node, b, empty = '') {
    setProp(node, 'textContent', b ? b.text : empty);
    setProp(node, 'title', b ? b.title : '');
    setProp(node, 'className', `mkt-badge ${b ? (b.stale ? 'stale' : b.text.toLowerCase()) : ''}`);
    setProp(node, 'hidden', !b && !empty);
  }

  function renderControls() {
    const { live, chainBtn, syncBtn, reason, connectBtn } = M.ui;
    setProp(connectBtn, 'hidden', !M.canConnect);
    setProp(connectBtn, 'disabled', M.connecting || M.othersBusy.size > 0);
    setProp(connectBtn, 'textContent', M.connecting ? 'Connecting…' : 'Connect IBKR');
    live.disabled = !M.online;
    live.checked = M.online && !!S.liveOn;
    chainBtn.disabled = !M.online;
    syncBtn.disabled = !M.online || M.syncing;
    if (!M.online) showChain(false);
    reason.textContent = M.reason;
    reason.title = M.reason;
    const b = live.checked ? badge(M.underlying, Date.now()) : null;
    paintBadge(M.ui.badge, b && { ...b, title: `${S.loadedSymbol} · ${b.title}` });
  }

  const clearButton = (leg) => el('button', { className: 'mkt-clear', textContent: 'typed ×',
    title: 'Clear the IV override so IV follows the market again',
    onclick: () => { Object.assign(leg, R.clearIvOverride(leg)); OD.changed(true); } });

  function addLegLine(tr) {
    const line = el('div', { className: 'sub mkt-leg' }, el('span'));
    tr.children[6].append(line);
    return line;
  }

  /** Custom keeps the DTE as typed, so it is the same as typing it: the leg comes off its date. */
  function onPickExpiry(leg, value) {
    if (value === '') {
      Object.assign(leg, R.onEdit(leg, 'dte'));
    } else {
      const e = M.listed.find((x) => `${x.expiry}|${x.trading_class}` === value);
      const dte = e ? settlementDte(e, Date.now()) : NaN;
      // A menu left over from a symbol or a day that is gone: redraw it rather than guess.
      if (!(dte > 0)) { decorateLegs(); return; }
      Object.assign(leg, R.pickExpiry(leg, e, S.loadedSymbol, dte));
    }
    OD.changed(true);
  }

  /** The DTE cell's menu of listed dates; the date under the DTE box shows only for Custom. */
  function paintExpiry(tr, leg) {
    const cell = tr.children[5];
    if (!cell) return;
    const when = cell.querySelector('[data-f=dte] + .sub');
    let menu = cell.querySelector('.mkt-exp');
    if (leg.kind === 'stock' || !M.listed.length) {
      if (menu) menu.remove();
      if (when) setProp(when, 'hidden', false);
      return;
    }
    if (!menu) {
      menu = el('select', { className: 'mkt-exp', title: 'Expiry date (New York). Sync links this exact expiry.' });
      cell.append(menu);
    }
    menu.onchange = () => onPickExpiry(leg, menu.value);
    if (menu === document.activeElement) return; // a rebuilt menu would close under the pointer
    const choices = expiryChoices(M.listed, leg, Date.now());
    const key = choices.map((c) => `${c.value}=${c.text}`).join(';');
    if (menu.dataset.key !== key) {
      menu.replaceChildren(...choices.map((c) => el('option', { value: c.value, textContent: c.text })));
      menu.dataset.key = key;
    }
    const chosen = choices.find((c) => c.selected).value;
    setProp(menu, 'value', chosen);
    if (when) setProp(when, 'hidden', chosen !== '');
  }

  /** Updates in place, because this runs on every poll and a rebuilt node drops hover and clicks. */
  function decorateRow(tr, leg) {
    paintExpiry(tr, leg);
    const found = tr.querySelector('.mkt-leg');
    if (!leg.live) { if (found) found.remove(); return; }
    const line = found || addLegLine(tr);
    paintBadge(line.firstChild, badge(M.quotes.get(contractKey(leg.live)), Date.now()), 'NO QUOTE');
    const clear = line.querySelector('.mkt-clear');
    if (leg.ivOverride && !clear) line.append(clearButton(leg));
    if (!leg.ivOverride && clear) clear.remove();
  }

  function decorateLegs() {
    const rows = $('legs').querySelectorAll('tr');
    S.legs.forEach((l, i) => { if (rows[i]) decorateRow(rows[i], l); });
  }

  function paintChainAge() {
    setProp(M.ui.age, 'textContent', M.chainAt === null ? '' : ageText(Date.now() - M.chainAt));
  }

  function renderBadges() { renderControls(); decorateLegs(); paintChainAge(); }

  /** Shows a leg's values in its existing row, leaving alone the field that has focus. */
  function fillRow(tr, leg) {
    const fill = (name, value) => {
      const input = tr.querySelector(`[data-f=${name}]`);
      if (input && input !== document.activeElement) setProp(input, 'value', value);
    };
    LEG_CELLS.forEach((name) => fill(name, String(leg[name] ?? '')));
    fill('dte', root.ODControls.dteText(leg.dte));
    const when = tr.querySelector('[data-f=dte] + .sub');
    if (when) setProp(when, 'textContent', OD.dteSub(leg.dte));
  }

  function remember(quotes) {
    const seen = Date.now();
    quotes.filter((q) => LABELS.has(q.data_type)).forEach((q) => M.quotes.set(contractKey(q),
      { source: q.source, data_type: q.data_type, as_of: q.as_of, mark_kind: q.mark_kind, seen }));
  }

  /** A row with a price just came back from a good reply: that is what keeps spot fresh. */
  function rememberSpot(row) { M.underlying = { ...row, seen: Date.now() }; }

  // ------------------------------------------------------------------ status
  function offlineReason(status) {
    if (status.sidecar !== 'online') return `Live unavailable: ${status.reason || 'market data offline'}`;
    return status.ibkr === 'connected' ? '' : `Using Yahoo: ${status.reason || 'TWS not connected'}`;
  }

  async function refreshStatus() {
    const status = await request(BROKER.status).catch((e) =>
      ({ sidecar: 'offline', reason: failText(e) }));
    const wasOnline = M.online;
    M.online = status.sidecar === 'online';
    M.reason = offlineReason(status);
    M.canConnect = canConnect(status);
    renderControls();
    if (M.online && !wasOnline) { poll(); loadListed(); }
  }

  /** One attempt to reach TWS. Nothing retries on its own, so this is the only way back to it. */
  async function connectIbkr() {
    if (M.connecting || M.othersBusy.size) return;
    M.connecting = true;
    renderControls();
    const busy = (on) => window.dispatchEvent(new CustomEvent(BROKER.busy, { detail: { source: 'analyser', busy: on } }));
    busy(true);
    const reply = await attempt(request(BROKER.connect, {}));
    M.connecting = false;
    busy(false);
    await refreshStatus();
    window.dispatchEvent(new CustomEvent(BROKER.event, { detail: { source: 'analyser' } }));
    if (reply.error) say(failText(reply.error), true);
    else if (reply.data.ibkr === 'connected') say('connected to TWS');
    else say(reply.data.reason || 'TWS not connected', true);
  }

  // ------------------------------------------------------------------ symbol
  function setListed(list) {
    M.listed = list.filter((e) => e.dte > 0);
    decorateLegs();
  }

  /** The dates for the legs' expiry menus. Without them the legs keep a typed DTE only. */
  async function loadListed() {
    const symbol = S.loadedSymbol;
    if (!symbol || !M.online) return;
    const reply = await attempt(request(expiriesPath(symbol)));
    if (S.loadedSymbol !== symbol) return;
    if (reply.error) { say(`expiry dates not available: ${failText(reply.error)}`, true); return; }
    setListed(validExpiries(reply.data && reply.data.expiries));
  }

  function applyLoaded(symbol, data) {
    const isNew = symbol !== S.loadedSymbol;
    const prevSpot = S.spot; // the page re-centres untouched what-if legs drawn for this spot
    if (isNew) M.listed = [];
    if (boxHolds(symbol)) {
      S.symbol = symbol;
      setProp($('symbol'), 'value', symbol);
    }
    S.loadedSymbol = symbol;
    S.liveOn = true;
    if (isNew && knownModel(data.suggested_model)) {
      S.model = data.suggested_model;
      $('model').value = S.model;
    }
    setSpot(spotFrom(S.spot, data));
    const hasPrice = spotFrom(null, data) !== null;
    if (hasPrice) rememberSpot(data); else M.underlying = null;
    assignLegs(R.unlinkOthers(S.legs, symbol));
    redrawLegs();
    if (!hasPrice) say(`no price for ${symbol} right now; spot left as it was`, true);
    renderControls();
    if (!M.ui.panel.hidden) loadExpiries(); else loadListed();
    // The Chart card follows the symbol; the page re-centres hypothetical legs on the new spot.
    window.dispatchEvent(new CustomEvent('od:symbol', { detail: { symbol, prevSpot, spot: S.spot } }));
  }

  /** After a bad symbol the chart axis must name what is really loaded. */
  function restoreSymbol(typed) {
    if (!S.loadedSymbol || !boxHolds(typed)) return;
    S.symbol = S.loadedSymbol;
    $('symbol').value = S.symbol;
    OD.changed(false);
  }

  async function loadSymbol(typed) {
    const symbol = String(typed).trim().toUpperCase();
    if (!symbol) { say('enter a symbol first', true); return false; }
    const seq = ++M.loadSeq;
    if (!M.online) await refreshStatus();
    if (!M.online) return false;
    const reply = await attempt(request(`/api/market/underlying/${encodeURIComponent(symbol)}`));
    if (seq !== M.loadSeq) return false;
    if (reply.error) {
      if (reply.error.status === 404) restoreSymbol(symbol);
      say(reply.error.status === 404 ? 'symbol not found' : failText(reply.error), true);
      return false;
    }
    applyLoaded(symbol, reply.data);
    poll();
    return true;
  }

  /** @returns {Promise<boolean>} true once the symbol in the box is the loaded one */
  async function ensureSymbol() {
    const typed = String(S.symbol).trim().toUpperCase();
    return typed === S.loadedSymbol || loadSymbol(typed);
  }

  // ------------------------------------------------------------------ polling
  const canPoll = () => M.online && !!S.liveOn && !!S.loadedSymbol
    && document.visibilityState === 'visible';

  function schedule(ms) {
    clearTimeout(M.timer);
    M.timer = canPoll() ? setTimeout(poll, ms) : null;
  }

  /** @returns {number} ms until the next poll */
  function applyPoll(data) {
    const quotes = validRows(data.quotes);
    const underlying = data.underlying || null;
    remember(quotes);
    if (spotFrom(null, underlying) !== null) rememberSpot(underlying);
    const next = refreshLegs(S.legs, quotes);
    const spot = spotFrom(S.spot, underlying);
    if (needsRedraw(S.legs, next) || spot !== S.spot) {
      assignLegs(next);
      setSpot(spot);
      OD.changed(false);
    }
    if (M.failed) say('market data is back');
    M.failed = false;
    return R.nextPollMs([underlying, ...quotes]);
  }

  /** @returns {Promise<object|null>} the reply, or null once the failure has been shown */
  async function requestQuotes(symbol) {
    const reply = await attempt(request('/api/market/quotes',
      priced({ symbol, contracts: linkedContracts(S.legs, symbol) })));
    const error = reply.error || (Array.isArray(reply.data.quotes) ? null : malformed(502));
    if (!error) return reply.data;
    M.failed = true;
    say(failText(error), true);
    if (!error.status || error.status === 503) refreshStatus();
    return null;
  }

  // A bug in applyPoll is not a market failure, so it goes to the console and polling continues.
  async function poll() {
    if (M.busy || !canPoll()) return;
    M.busy = true;
    const symbol = S.loadedSymbol;
    let wait = R.nextPollMs([]);
    try {
      const data = await requestQuotes(symbol);
      // Live went off or the symbol changed while this was out: the reply no longer applies.
      if (data && S.liveOn && S.loadedSymbol === symbol) wait = applyPoll(data);
    } finally {
      M.busy = false;
      renderBadges();
      schedule(wait);
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') { refreshStatus(); poll(); return; }
    clearTimeout(M.timer);
    M.timer = null;
  }

  async function onLiveToggle() {
    const on = M.ui.live.checked;
    if (on && !S.loadedSymbol) {
      await loadSymbol(S.symbol);
      renderControls();
      return;
    }
    S.liveOn = on;
    OD.changed(false);
    renderControls();
    poll();
  }

  function stopLive() {
    if (!S.liveOn) return;
    S.liveOn = false;
    OD.changed(false); // saves, so a reload keeps the what-if spot
    renderControls();
  }

  // ------------------------------------------------------------------ chain panel
  const chainNote = (msg) => { M.ui.note.textContent = msg; };

  function pick(q, long) {
    const made = R.legFromQuote(q, long);
    S.legs.push(made.iv === null ? { ...made, iv: DEFAULT_IV } : made);
    remember([q]);
    OD.legsChanged();
    if (made.iv === null) say(`no IV for that contract; using ${DEFAULT_IV}%, please check it`, true);
  }

  function priceCell(q, field, long) {
    const cell = quoteCell(q[field], q.last);
    const hasMark = num(q.mark);
    const action = `${long ? 'BUY' : 'SELL'} at mark ${hasMark ? q.mark.toFixed(2) : 'unavailable'}`;
    return el('td', {}, el('button', {
      className: `mkt-q ${long ? 'ask' : 'bid'}${cell.isLast ? ' last' : ''}`,
      textContent: cell.text, disabled: !hasMark, title: `${action} · ${q.source} · as of ${q.as_of}`,
      onclick: () => pick(q, long),
    }));
  }

  function sideCells(q) {
    if (!q) return [0, 1, 2, 3].map(() => el('td'));
    return [priceCell(q, 'bid', false), priceCell(q, 'ask', true),
      el('td', { textContent: num(q.iv) ? `${(q.iv * 100).toFixed(1)}%` : '—' }),
      el('td', { textContent: num(q.delta) ? q.delta.toFixed(2) : '—' })];
  }

  function chainHead() {
    const names = ['Bid', 'Ask', 'IV', 'Δ'];
    const th = (textContent, props = {}) => el('th', { textContent, ...props });
    return el('thead', {},
      el('tr', {}, th('Calls', { colSpan: 4 }), th(''), th('Puts', { colSpan: 4 })),
      el('tr', {}, ...names.map((n) => th(n)), th('Strike'), ...names.map((n) => th(n))));
  }

  function drawChain(data) {
    const rows = validRows(data.rows);
    const table = chainTable(rows);
    const spot = num(data.spot) ? data.spot : S.spot;
    const atm = nearestStrike(table, spot);
    const strikeCell = (r) => el('td', { className: 'strike', textContent: String(r.strike) });
    const body = el('tbody', {}, ...table.map((r) => el('tr', { className: r.strike === atm ? 'atm' : '' },
      ...sideCells(r.call), strikeCell(r), ...sideCells(r.put))));
    M.ui.chain.replaceChildren(el('table', { className: 'mkt-chain' }, chainHead(), body));
    M.chainAt = Date.now();
    paintChainAge();
    const sources = chainSources(rows).join(', ') || 'no source';
    chainNote(table.length ? `spot ${spot} · ${sources} · click a bid to sell, an ask to buy`
      : 'no quotes for this expiry');
    const row = body.querySelector('.atm');
    if (row) M.ui.chain.scrollTop = row.offsetTop - M.ui.chain.clientHeight / 2;
  }

  function clearChain(note) {
    M.chainAt = null;
    paintChainAge();
    M.ui.chain.replaceChildren();
    chainNote(note);
  }

  /** Runs only on request: each load holds about 50 market data lines while it snapshots. */
  async function loadChain() {
    const expiry = M.expiries[+M.ui.expiry.value];
    if (!expiry) return;
    const seq = ++M.chainSeq;
    clearChain('loading chain…');
    const reply = await attempt(request('/api/market/chain', priced({ symbol: S.loadedSymbol,
      expiry: expiry.expiry, trading_class: expiry.trading_class })));
    if (seq !== M.chainSeq) return;
    if (reply.error) { chainNote('chain not available'); say(failText(reply.error), true); return; }
    drawChain(reply.data);
  }

  async function loadExpiries() {
    const seq = ++M.chainSeq;
    clearChain('loading expiries…');
    M.ui.expiry.replaceChildren();
    const reply = await attempt(request(expiriesPath(S.loadedSymbol)));
    if (seq !== M.chainSeq) return;
    if (reply.error) { chainNote('expiries not available'); say(failText(reply.error), true); return; }
    M.expiries = validExpiries(reply.data.expiries).filter((e) => e.dte > 0);
    setListed(M.expiries);
    M.ui.expiry.replaceChildren(...M.expiries.map((e, i) =>
      el('option', { value: String(i), textContent: expiryLabel(e) })));
    M.ui.expiry.value = String(M.expiries.indexOf(nearestExpiry(M.expiries, S.pdte)));
    await loadChain();
    if (!M.expiries.length) chainNote('no listed expiries');
  }

  /** Every open and close goes through here, so the button never shows the wrong sign. */
  function showChain(open) {
    const face = chainFace(open);
    setProp(M.ui.panel, 'hidden', !open);
    setProp(M.ui.chainBtn, 'textContent', face.text);
    setProp(M.ui.chainBtn, 'title', face.title);
  }

  async function toggleChain() {
    showChain(M.ui.panel.hidden);
    if (M.ui.panel.hidden) return;
    const typed = String(S.symbol).trim().toUpperCase();
    if (typed === S.loadedSymbol) { loadExpiries(); return; }
    if (!(await ensureSymbol())) showChain(false); // stays open on success: applyLoaded fills it
  }

  // ------------------------------------------------------------------ sync
  async function askQuotes(symbol, contracts) {
    const reply = await attempt(request('/api/market/quotes', priced({ symbol, contracts })));
    return reply.error ? reply : { data: validRows(reply.data.quotes) };
  }

  /** A freshly requested contract may have nothing yet, so it gets one more try. */
  async function quotesFor(symbol, contracts) {
    const first = await askQuotes(symbol, contracts);
    if (first.error) return first;
    const missing = P.unpriced(contracts, first.data);
    if (!missing.length) return first;
    await new Promise((done) => { setTimeout(done, RETRY_MS); });
    const retry = await askQuotes(symbol, missing);
    return { data: retry.error ? first.data : P.mergeQuotes(first.data, retry.data) };
  }

  /** Adds each group's listed strikes, null where the lookup failed; a 404 lists none. */
  async function withStrikes(symbol, groups) {
    const filled = [];
    let failure = '';
    for (const group of groups) {
      const listed = await attempt(request(strikesPath(symbol, group)));
      const failed = !!listed.error && listed.error.status !== 404;
      if (failed) failure = failText(listed.error);
      const strikes = failed ? null : P.validStrikes(listed.data && listed.data.strikes);
      filled.push({ ...group, strikes });
    }
    return { groups: filled, failure };
  }

  /** @returns {Promise<{results: object[], failure: string}>} the outcome of every snap */
  async function priceSnaps(symbol, snaps) {
    const contracts = P.snapContracts(snaps);
    const quoted = contracts.length ? await quotesFor(symbol, contracts) : { data: [] };
    if (!quoted.error) {
      remember(quoted.data);
      return { results: P.resolveSnaps(snaps, quoted.data, S.legs), failure: '' };
    }
    return { results: snaps.map((s) => (s.miss ? s : { ...s, miss: 'failed' })),
      failure: failText(quoted.error) };
  }

  function finishSync(results, unmatched, failure) {
    results.filter((r) => r.next).forEach((r) => Object.assign(r.leg, r.next));
    S.legs.filter((l) => l.kind === 'stock')
      .forEach((l) => Object.assign(l, R.syncLeg(l, null, S.spot)));
    redrawLegs();
    // Pricing patches only theo and delta while a row has focus, so the rest is filled in here.
    if (typingInLegs()) {
      const rows = $('legs').querySelectorAll('tr');
      S.legs.forEach((l, i) => { if (rows[i]) fillRow(rows[i], l); });
    }
    const { linked, filled, unfilled, fromLast, misses } = P.tally(results, unmatched);
    // A premium from a last trade is shown as a warning: it is not a price you could trade at now.
    say(P.syncSummary(linked, misses, failure, filled, unfilled, fromLast),
      misses.length + unfilled + fromLast > 0);
  }

  async function runSync(symbol) {
    const hasOpen = S.legs.some((l) => !l.live && l.kind !== 'stock');
    const listed = hasOpen ? await attempt(request(expiriesPath(symbol))) : { data: {} };
    const plan = P.planSync(S.legs, validExpiries(listed.data && listed.data.expiries));
    const { groups, failure } = await withStrikes(symbol, plan.groups);
    if (S.loadedSymbol !== symbol) return; // a new symbol unlinked everything this was for
    const priced = await priceSnaps(symbol, P.planContracts(S.legs, groups, symbol));
    if (S.loadedSymbol !== symbol) return;
    const unmatched = plan.unmatched.map((leg) => ({ leg, miss: listed.error ? 'failed' : 'no_contract' }));
    finishSync(priced.results, unmatched,
      (listed.error && failText(listed.error)) || priced.failure || failure);
  }

  async function syncToMarket() {
    if (M.syncing) return;
    M.syncing = true;
    renderControls();
    say('syncing to market…');
    try {
      if (await ensureSymbol()) await runSync(S.loadedSymbol);
    } catch (e) {
      say('sync stopped on an unexpected error; see the browser console', true);
      throw e; // request failures never land here: `attempt` turns them into values
    } finally {
      M.syncing = false;
      renderControls();
    }
  }

  // ------------------------------------------------------------------ setup
  const STYLE = `
    .mkt-live { display: flex; align-items: center; gap: 8px; height: 30px; }
    .mkt-live input { width: 16px; height: 16px; margin: 0; padding: 0; accent-color: var(--accent); }
    .mkt-reason { max-width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mkt-badge { font: 600 10px/1.5 var(--mono); letter-spacing: .05em; padding: 0 5px; border-radius: 4px;
      border: 1px solid var(--line-2); color: var(--muted); white-space: nowrap; }
    .mkt-badge[hidden], .mkt-panel[hidden], .mkt-connect[hidden] { display: none; }
    .mkt-badge.live { color: var(--pos); border-color: var(--pos); }
    .mkt-badge.delayed { color: var(--blue); border-color: var(--blue); }
    .mkt-badge.yahoo { color: var(--accent); border-color: var(--accent); }
    .mkt-badge.stale { color: var(--neg); border-color: var(--neg); }
    .mkt-leg { display: flex; align-items: center; gap: 4px; margin-top: 3px; }
    .mkt-exp { display: block; width: 100%; margin-top: 3px; height: 24px; font-size: 11px;
      background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; padding: 0 4px; }
    .mkt-clear { background: transparent; border: 0; padding: 0; color: var(--muted); cursor: pointer; font: inherit; }
    .mkt-clear:hover { color: var(--text); }
    .mkt-panel { border-bottom: 1px solid var(--line); }
    .mkt-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; flex-wrap: wrap; }
    .mkt-bar label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .mkt-bar select { background: var(--bg); border: 1px solid var(--line-2); border-radius: 6px; height: 28px; padding: 0 6px; }
    .mkt-scroll { max-height: 340px; overflow: auto; }
    table.mkt-chain { width: 100%; min-width: 640px; border-collapse: collapse; font: 12px var(--mono); }
    .mkt-chain th { position: sticky; top: 0; background: var(--panel); font: 600 10.5px var(--sans); color: var(--faint); padding: 4px 6px; text-align: center; }
    .mkt-chain thead tr + tr th { top: 22px; border-bottom: 1px solid var(--line); }
    .mkt-chain td { padding: 1px 6px; text-align: center; color: var(--muted); border-bottom: 1px solid var(--line); }
    .mkt-chain td.strike { color: var(--text); font-weight: 600; background: var(--panel-2); }
    .mkt-chain tr.atm td { background: rgba(242,184,75,.1); }
    .mkt-chain tr.atm td.strike { color: var(--accent); }
    .mkt-q { width: 100%; background: transparent; border: 0; border-radius: 4px; padding: 2px 4px; cursor: pointer; font: inherit; }
    .mkt-q:disabled { cursor: default; color: var(--faint); }
    .mkt-q.last { color: var(--faint); font-style: italic; }
    .mkt-q.bid:hover:enabled { background: var(--neg-bg); color: var(--neg); }
    .mkt-q.ask:hover:enabled { background: var(--pos-bg); color: var(--pos); }`;

  function buildHeader() {
    const liveTip = 'Keep spot and IV updating from market data (option prices stay as typed)';
    M.ui.live = el('input', { type: 'checkbox', id: 'mktlive', disabled: true, onchange: onLiveToggle, title: liveTip });
    M.ui.badge = el('span', { className: 'mkt-badge', hidden: true });
    M.ui.reason = el('div', { className: 'status mkt-reason' });
    M.ui.connectBtn = el('button', { className: 'btn mkt-connect', textContent: 'Connect IBKR', hidden: true,
      title: 'Try once to reach TWS. Open TWS first; Yahoo carries on until it connects.', onclick: connectIbkr });
    $('symbol').parentElement.after(el('div', { className: 'field' },
      el('label', { htmlFor: 'mktlive', textContent: 'Live', title: liveTip }),
      el('div', { className: 'mkt-live' }, M.ui.live, M.ui.badge)));
    $('status').before(M.ui.connectBtn, M.ui.reason);
  }

  function buildLegsTools() {
    const shut = chainFace(false);
    M.ui.chainBtn = el('button', { className: 'btn', textContent: shut.text, title: shut.title,
      disabled: true, onclick: toggleChain });
    M.ui.syncBtn = el('button', { className: 'btn', textContent: 'Sync to market', disabled: true, onclick: syncToMarket,
      title: 'Link unlinked legs to the nearest listed contracts, within 5% of their strike, and fill blank premiums' });
    document.querySelector('[data-add=call]').before(M.ui.chainBtn, M.ui.syncBtn);
    M.ui.expiry = el('select', { id: 'mktexpiry', onchange: loadChain });
    M.ui.age = el('span', { className: 'legend-note mkt-age' });
    M.ui.refresh = el('button', { className: 'iconbtn', textContent: 'Refresh', onclick: loadChain,
      title: 'Load this chain again' });
    M.ui.note = el('span', { className: 'legend-note' });
    M.ui.chain = el('div', { className: 'mkt-scroll' });
    M.ui.panel = el('div', { className: 'mkt-panel', hidden: true },
      el('div', { className: 'mkt-bar' }, el('label', { htmlFor: 'mktexpiry', textContent: 'Expiry' }),
        M.ui.expiry, M.ui.age, M.ui.refresh, M.ui.note),
      M.ui.chain);
    document.querySelector('.legs-wrap').before(M.ui.panel);
  }

  function bindInputs() {
    $('symbol').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loadSymbol(e.target.value); }
    });
    $('spot').addEventListener('input', stopLive);
    $('spot').addEventListener('blur', () => { if (S.liveOn) $('spot').value = S.spot; });
    document.addEventListener('visibilitychange', onVisibility);
    // the nav chip (or another module) connected or disconnected TWS: re-read the shared state
    window.addEventListener(BROKER.event, (e) => { if (!isOwnBrokerEvent(e)) refreshStatus(); });
    window.addEventListener(BROKER.busy, (e) => {
      const d = e.detail || {};
      if (!d.source || isOwnBrokerEvent(e)) return;
      if (d.busy) M.othersBusy.add(d.source); else M.othersBusy.delete(d.source);
      renderControls();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') { refreshStatus(); ageSavedLegs(); renderBadges(); }
    }, STATUS_MS);
  }

  /** A saved leg may wait a long time for a quote, with Live off or the sidecar away. */
  function ageSavedLegs() {
    if (M.syncing) return; // Sync reads a moved DTE as an edit and would drop that leg
    const next = ageLegs(S.legs, Date.now());
    if (!needsRedraw(S.legs, next)) return;
    assignLegs(next);
    redrawLegs(); // this also runs on a timer, so it must not pull the table out from under typing
  }

  document.head.append(el('style', { textContent: STYLE }));
  buildHeader();
  buildLegsTools();
  bindInputs();
  OD.afterLegs = decorateLegs;
  decorateLegs();
  ageSavedLegs();
  refreshStatus();
  ODForward.render($('fwdiv'), S.legs, S.ivShift);  // last: a failure here must not stop the rest
})(globalThis);
