// Pure helpers for the Portfolio page: cost basis grouped by underlying and expiry, from
// the rows /api/broker/positions returns. No DOM, no network; the page code is page.js.
// Node tests load this file directly.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Portfolio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isOption = (p) => p.sec_type === 'OPT';
  const usable = (p) => !!p && typeof p.symbol === 'string' && Number.isFinite(p.qty)
    && Number.isFinite(p.avg_cost) && (p.sec_type === 'OPT' || p.sec_type === 'STK');

  /** Signed cost basis in dollars: positive = paid (long), negative = received (short). */
  function cost(p) {
    return p.qty * p.avg_cost * (isOption(p) ? (p.multiplier || 100) : 1);
  }

  /** "AAPL 18 Dec 26 200 C", or "AAPL stock". */
  function legLabel(p) {
    if (!isOption(p)) return `${p.symbol} stock`;
    const [y, m, d] = String(p.expiry || '').split('-');
    const when = y ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y.slice(2)}` : 'no expiry';
    return `${p.symbol} ${when} ${p.strike} ${p.kind === 'put' ? 'P' : 'C'}`;
  }

  const round2 = (x) => Math.round(x * 100) / 100;

  /**
   * @param {Array<object>} positions rows from /api/broker/positions
   * @returns {{byUnderlying: object[], byExpiry: object[], totals: object, rows: object[]}}
   */
  function summarise(positions) {
    const rows = (Array.isArray(positions) ? positions : []).filter(usable)
      .map((p) => ({ ...p, cost: cost(p), label: legLabel(p) }));
    const under = new Map();
    const expiry = new Map();
    for (const r of rows) {
      const u = under.get(r.symbol) || { symbol: r.symbol, legs: 0, shares: 0, net: 0, gross: 0 };
      under.set(r.symbol, {
        ...u, legs: u.legs + 1, net: u.net + r.cost, gross: u.gross + Math.abs(r.cost),
        shares: u.shares + (isOption(r) ? 0 : r.qty),
      });
      if (isOption(r) && r.expiry) {
        const e = expiry.get(r.expiry) || { expiry: r.expiry, legs: 0, net: 0, gross: 0 };
        expiry.set(r.expiry, { ...e, legs: e.legs + 1, net: e.net + r.cost, gross: e.gross + Math.abs(r.cost) });
      }
    }
    const tidy = (o) => ({ ...o, net: round2(o.net), gross: round2(o.gross) });
    return {
      rows,
      byUnderlying: [...under.values()].map(tidy).sort((a, b) => b.gross - a.gross),
      byExpiry: [...expiry.values()].map(tidy).sort((a, b) => (a.expiry < b.expiry ? -1 : 1)),
      totals: {
        positions: rows.length,
        net: round2(rows.reduce((s, r) => s + r.cost, 0)),
        gross: round2(rows.reduce((s, r) => s + Math.abs(r.cost), 0)),
      },
    };
  }

  // ------------------------------------------------------------ v2: Greeks and live P&L

  const MAX_CONTRACTS = 32; // the quotes API's per-request limit
  const compact = (iso) => String(iso || '').replace(/-/g, '');
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);

  /**
   * Quote requests for the held options, one batch per underlying (at most 32 contracts each).
   * Options without a trading class cannot be quoted and are left out.
   * @returns {Array<{symbol: string, contracts: object[]}>}
   */
  function quoteRequests(positions) {
    const by = new Map();
    for (const p of (Array.isArray(positions) ? positions : []).filter(usable)) {
      if (!isOption(p) || !p.trading_class || !p.expiry) continue;
      const list = by.get(p.symbol) || [];
      by.set(p.symbol, [...list, { symbol: p.symbol, expiry: compact(p.expiry), strike: p.strike,
        right: p.kind === 'put' ? 'P' : 'C', trading_class: p.trading_class }]);
    }
    const out = [];
    for (const [symbol, contracts] of by) {
      for (let i = 0; i < contracts.length; i += MAX_CONTRACTS) {
        out.push({ symbol, contracts: contracts.slice(i, i + MAX_CONTRACTS) });
      }
    }
    return out;
  }

  /** The quote for one held option (matched by expiry, strike and right), or null. */
  function findQuote(quotes, p) {
    const right = p.kind === 'put' ? 'P' : 'C';
    return (Array.isArray(quotes) ? quotes : []).find((q) => q && q.expiry === compact(p.expiry)
      && q.strike === p.strike && q.right === right) || null;
  }

  /**
   * Engine legs for one underlying's positions. Premium is my fill, so P&L is measured from
   * cost. An option with no quote, or no IV, goes to `unpriced` rather than being guessed.
   */
  function buildLegs(positions, quotes) {
    const legs = [];
    const unpriced = [];
    for (const p of (Array.isArray(positions) ? positions : []).filter(usable)) {
      if (!isOption(p)) {
        legs.push({ kind: 'stock', long: p.qty > 0, qty: Math.abs(p.qty), strike: 0, dte: 0, iv: 0,
          premium: p.avg_cost, multiplier: 1, enabled: true });
        continue;
      }
      const q = findQuote(quotes, p);
      if (!q || !finite(q.iv) || !(q.iv > 0) || !finite(q.dte)) { unpriced.push(p); continue; }
      legs.push({ kind: p.kind === 'put' ? 'put' : 'call', long: p.qty > 0, qty: Math.abs(p.qty),
        strike: p.strike, dte: q.dte, iv: q.iv, premium: p.avg_cost, multiplier: p.multiplier || 100,
        enabled: true });
    }
    return { legs, unpriced };
  }

  /** Unrealised P&L in dollars from my fill to the current mark; null without a mark. */
  function unrealised(p, quote) {
    if (!quote || !finite(quote.mark)) return null;
    return round2(p.qty * (quote.mark - p.avg_cost) * (isOption(p) ? (p.multiplier || 100) : 1));
  }

  const ZERO_G = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  /** Sum of whole-position Greeks; missing entries are ignored. */
  function sumGreeks(list) {
    const t = (Array.isArray(list) ? list : []).filter(Boolean).reduce((a, g) => ({
      delta: a.delta + (g.delta || 0), gamma: a.gamma + (g.gamma || 0), theta: a.theta + (g.theta || 0),
      vega: a.vega + (g.vega || 0), rho: a.rho + (g.rho || 0) }), ZERO_G);
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
  }

  // ------------------------------------------------------------ account cash

  const FIGURES = [['cash', 'cash'], ['net_liquidation', 'netLiquidation'],
    ['available_funds', 'availableFunds'], ['buying_power', 'buyingPower']];

  /**
   * Cash, net liquidation, available funds and buying power from /api/broker/account rows
   * (one per account and currency). Accounts in the same currency are added up; with several
   * currencies the one with the most net liquidation is shown and the others are named, never
   * mixed in. A figure TWS did not send stays null: "no data" must not read as "$0".
   * @returns {object|null} null when there is nothing to show
   */
  function accountSummary(accounts) {
    const rows = (Array.isArray(accounts) ? accounts : []).filter((r) => r && typeof r === 'object'
      && FIGURES.some(([k]) => finite(r[k])));
    if (!rows.length) return null;
    const byCurrency = new Map();
    for (const r of rows) {
      const cur = r.currency || 'USD';
      byCurrency.set(cur, [...(byCurrency.get(cur) || []), r]);
    }
    const size = (list) => list.reduce((s, r) => s + Math.abs(finite(r.net_liquidation) ? r.net_liquidation : 0), 0);
    const ranked = [...byCurrency.entries()].sort((a, b) => size(b[1]) - size(a[1]) || (a[0] < b[0] ? -1 : 1));
    const [currency, list] = ranked[0];
    const total = (key) => {
      const known = list.map((r) => r[key]).filter(finite);
      return known.length ? round2(known.reduce((a, b) => a + b, 0)) : null;
    };
    return {
      currency, accounts: list.length,
      ...Object.fromEntries(FIGURES.map(([from, to]) => [to, total(from)])),
      otherCurrencies: ranked.slice(1).map(([c]) => c),
    };
  }

  // ------------------------------------------------------------ saved snapshot (shown when TWS is off)

  /** The CSV upload format: `type` (stock, call or put) tells shares and options apart. */
  const TEMPLATE_CSV = [
    'type,symbol,qty,avg_cost,strike,expiry,multiplier,trading_class,account',
    'stock,AAPL,100,212.40,,,,,',
    'call,SPY,-2,4.35,600,2026-12-18,,,',
    'put,SPX,1,12.50,5800,2026-12-18,,SPXW,',
  ].join('\n') + '\n';

  const pad = (n) => String(n).padStart(2, '0');

  /** "6 Nov 26 09:05" in local time. */
  function savedWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'an unknown time';
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const snapshotSource = (snap) => (snap && snap.source === 'tws' ? 'last TWS read' : 'CSV upload');

  const CASH_KEYS = [['cash', 'Cash'], ['net_liquidation', 'Net liquidation'],
    ['available_funds', 'Available funds'], ['buying_power', 'Buying power']];

  /** Text for the cash inputs from saved account rows (first row; blank where no figure). */
  function cashForm(accounts) {
    const row = (Array.isArray(accounts) && accounts[0]) || {};
    return { currency: row.currency || 'USD',
      ...Object.fromEntries(CASH_KEYS.map(([k]) => [k, finite(row[k]) ? String(row[k]) : ''])) };
  }

  /** The cash inputs as the upload's `cash` body: { body } or { error }. Blank is "no figure". */
  function cashBody(form) {
    const currency = String(form.currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Currency must be a three-letter code such as USD.' };
    const body = { currency };
    for (const [k, label] of CASH_KEYS) {
      const text = String(form[k] || '').trim().replace(/[$,]/g, '');
      const v = text === '' ? null : Number(text);
      if (v !== null && !Number.isFinite(v)) return { error: `${label} must be a number (got "${String(form[k]).trim()}").` };
      body[k] = v;
    }
    return { body };
  }

  // ------------------------------------------------------------ journal positions

  const EPS = 1e-6; // net_qty comes rounded to 6 places

  /** "#12 bull put spread" (just "#12" without a strategy). */
  function tradeLabel(t) {
    const strategy = t && typeof t.strategy === 'string' ? t.strategy.replace(/_/g, ' ') : '';
    return `#${t && t.id}${strategy ? ` ${strategy}` : ''}`;
  }

  /** One open leg as a position row, or null when the leg is flat or unreadable. */
  function journalLeg(t, symbol, l) {
    if (!l || !finite(l.net_qty) || Math.abs(l.net_qty) < EPS || !finite(l.avg_cost)) return null;
    const ref = { trade_id: t.id, account: tradeLabel(t) };
    if (l.kind === 'stock') {
      return { symbol, sec_type: 'STK', kind: 'stock', strike: null, expiry: null,
        multiplier: finite(l.multiplier) ? l.multiplier : 1, qty: l.net_qty, avg_cost: l.avg_cost, ...ref };
    }
    if ((l.kind !== 'call' && l.kind !== 'put') || !finite(l.strike) || typeof l.expiry !== 'string') return null;
    // The journal keeps no trading class; the underlying's own class is the analyser's convention too.
    return { symbol, sec_type: 'OPT', kind: l.kind, strike: l.strike, expiry: l.expiry.slice(0, 10),
      multiplier: finite(l.multiplier) ? l.multiplier : 100, qty: l.net_qty, avg_cost: l.avg_cost,
      trading_class: symbol, ...ref };
  }

  /**
   * Position rows (the broker's shape) for every open leg of the open journal trades.
   * @param {Array<object>} trades GET /api/journal/trades data (legs carry net_qty and avg_cost)
   */
  function journalRows(trades) {
    return (Array.isArray(trades) ? trades : [])
      .filter((t) => t && t.status === 'open' && Number.isInteger(t.id) && typeof t.underlying === 'string'
        && Array.isArray(t.legs))
      .flatMap((t) => t.legs.map((l) => journalLeg(t, t.underlying.toUpperCase(), l)).filter(Boolean));
  }

  /** The contract a row holds: options by symbol, right, strike and expiry; stock by symbol. */
  function contractKey(p) {
    const symbol = String(p.symbol || '').toUpperCase();
    if (!isOption(p)) return `${symbol}|stock`;
    return `${symbol}|${p.kind === 'put' ? 'P' : 'C'}|${Number(p.strike)}|${String(p.expiry || '').slice(0, 10)}`;
  }

  // ------------------------------------------------------------ accounts: one source of truth each
  // An IBKR account reads TWS (else its saved snapshot); an Other account with source csv shows its
  // uploaded snapshot; a Paper account, or an Other account with source journal, shows its open
  // journal trades. The journal labels broker rows (grouping.js); it is never added to them.

  const isIbkr = (a) => !!a && a.type === 'ibkr';
  const isJournalSourced = (a) => !!a && a.source === 'journal';
  const list = (x) => (Array.isArray(x) ? x : []);

  /** The id of the IBKR account a broker account number belongs to: broker_ref (any case), else the lowest-id IBKR account. */
  function brokerAccountFor(accounts, ref) {
    const ibkrs = list(accounts).filter(isIbkr);
    if (!ibkrs.length) return null;
    const key = String(ref || '').trim().toLowerCase();
    const hit = key && ibkrs.find((a) => String(a.broker_ref || '').trim().toLowerCase() === key);
    return hit ? hit.id : Math.min(...ibkrs.map((a) => a.id));
  }

  /** Broker rows (positions or cash) per IBKR account id, by each row's `account`. Every IBKR account gets an entry. */
  function splitByBroker(accounts, rows) {
    const out = Object.fromEntries(list(accounts).filter(isIbkr).map((a) => [a.id, []]));
    for (const r of list(rows).filter(Boolean)) {
      const id = brokerAccountFor(accounts, r.account);
      if (id !== null) out[id] = [...out[id], r];
    }
    return out;
  }

  /**
   * The PUT …/snapshot/tws bodies after a successful TWS read: one per IBKR account that got rows
   * or cash, plus the fallback (lowest-id) account even when flat. An account TWS knows nothing
   * about keeps its saved copy. cashRows null (the cash read failed) leaves the saved cash alone.
   * @returns {Array<{id: number, positions: object[], accounts?: object[]}>}
   */
  function twsSaves(accounts, positions, cashRows) {
    const fallback = brokerAccountFor(accounts, '');
    if (fallback === null) return [];
    const pos = splitByBroker(accounts, positions);
    const cash = cashRows ? splitByBroker(accounts, cashRows) : null;
    return list(accounts).filter(isIbkr)
      .filter((a) => a.id === fallback || pos[a.id].length || (cash && cash[a.id].length))
      .map((a) => (cash ? { id: a.id, positions: pos[a.id], accounts: cash[a.id] } : { id: a.id, positions: pos[a.id] }));
  }

  /**
   * What one account shows.
   * @param {{account: object, twsRows: object[]|null, twsCash?: object[]|null, snapshot: object|null,
   *   journalTrades: object[]}} input twsRows are this account's rows, null when TWS did not answer
   * @returns {{account, rows, cash, trades, source: 'tws'|'saved'|'csv'|'journal'|'none',
   *   sourceLabel: string, brokerSourced: boolean}}
   */
  function accountRows({ account, twsRows, twsCash, snapshot, journalTrades }) {
    const trades = list(journalTrades).filter((t) => t && t.status === 'open' && t.account_id === account.id);
    const base = { account, trades, brokerSourced: !isJournalSourced(account) };
    if (isJournalSourced(account)) {
      return { ...base, rows: journalRows(trades), cash: [], source: 'journal', sourceLabel: 'Journal' };
    }
    if (isIbkr(account) && Array.isArray(twsRows)) {
      return { ...base, rows: twsRows, cash: list(twsCash), source: 'tws', sourceLabel: 'TWS live' };
    }
    if (snapshot && typeof snapshot === 'object') {
      const csv = snapshot.source !== 'tws';
      return { ...base, rows: list(snapshot.positions), cash: list(snapshot.accounts), source: csv ? 'csv' : 'saved',
        sourceLabel: `${csv ? 'CSV' : 'Saved'} ${savedWhen(snapshot.saved_at)}` };
    }
    return { ...base, rows: [], cash: [], source: 'none', sourceLabel: 'Nothing saved' };
  }

  const replyStatus = (reply) => (reply ? reply.status : 0);
  const okData = (reply) => (reply && reply.status >= 200 && reply.status < 300 && reply.body && reply.body.ok
    ? { data: reply.body.data }
    : { error: (reply && reply.body && reply.body.error) || `request failed (${replyStatus(reply)})` });
  const brokerError = (reply) => (reply && reply.body && (reply.body.error || reply.body.message))
    || `request failed (${replyStatus(reply)})`;

  /** The TWS read: positions, then (only after them: the sidecar takes one account read at a time) cash. */
  async function readTws(request) {
    const pos = await request('/api/broker/positions');
    if (!(pos.status >= 200 && pos.status < 300)) {
      return { state: pos.status === 409 ? 'offline' : 'failed', error: brokerError(pos), positions: null, cash: null };
    }
    const cash = await request('/api/broker/account');
    const ok = cash.status >= 200 && cash.status < 300 && cash.body && Array.isArray(cash.body.accounts);
    return { state: 'live', error: '', asOf: (pos.body && pos.body.as_of) || '', positions: list(pos.body && pos.body.positions),
      cash: ok ? cash.body.accounts : null, cashStatus: cash.status };
  }

  /**
   * Everything the Portfolio page and the Home card show, for the selected accounts in list order.
   * request(url) resolves to {status, body} and never throws. Reads TWS only when an IBKR account
   * is shown; reads a snapshot only for an account that has one and needs it.
   */
  async function gather({ accounts, selected, request }) {
    const all = list(accounts);
    const want = new Set(list(selected));
    const picked = all.filter((a) => want.has(a.id));
    const shown = picked.length ? picked : all;
    const ids = shown.map((a) => a.id).sort((x, y) => x - y);
    const query = shown.length === all.length ? '' : `?accounts=${ids.join(',')}`;
    const tradesReply = okData(await request(`/api/journal/trades${query}`));
    const tws = shown.some(isIbkr) ? await readTws(request) : { state: 'skipped', error: '', positions: null, cash: null };
    const live = tws.state === 'live';
    const needsSnap = (a) => !isJournalSourced(a) && !(live && isIbkr(a)) && !!a.snapshot;
    const snaps = await Promise.all(shown.map((a) => (needsSnap(a)
      ? request(`/api/journal/accounts/${a.id}/snapshot`).then((r) => okData(r).data || null) : null)));
    const pos = live ? splitByBroker(all, tws.positions) : {};
    const cash = live && tws.cash ? splitByBroker(all, tws.cash) : {};
    return {
      tws,
      journalError: tradesReply.error || '',
      shown: shown.map((account, i) => accountRows({ account, twsRows: live && isIbkr(account) ? pos[account.id] : null,
        twsCash: cash[account.id] || [], snapshot: snaps[i], journalTrades: list(tradesReply.data) })),
    };
  }

  /** Position totals and combined cash over the shown accounts. */
  function totalsOf(shown) {
    return { summary: summarise(list(shown).flatMap((a) => list(a.rows))),
      cash: accountSummary(list(shown).flatMap((a) => list(a.cash))) };
  }

  /**
   * The cash tiles' state from gather()'s result and totalsOf().cash: { summary, reason, missing }.
   * The reason says why there is no figure, so "no data" never reads as "$0".
   */
  function cashState(data, summary) {
    const shown = list(data && data.shown);
    const tws = (data && data.tws) || {};
    const live = shown.some((a) => a.source === 'tws');
    if (summary) return { summary, reason: '', missing: live ? 'TWS sent no cash figures' : 'not saved' };
    let reason = 'no cash for these accounts';
    if (live) reason = tws.cash ? 'TWS sent no cash figures' : 'unavailable';
    else if (shown.some((a) => a.source === 'saved' || a.source === 'csv')) reason = 'not saved';
    else if (tws.state === 'offline') reason = 'not connected to TWS';
    else if (tws.state === 'failed') reason = 'unavailable';
    return { summary: null, reason };
  }

  /** The journal page of one trade, or null for anything but a whole-number id. */
  const tradeHref = (id) => (Number.isInteger(id) ? `/journal/trade?id=${id}` : null);

  return { cost, legLabel, summarise, quoteRequests, findQuote, buildLegs, unrealised, sumGreeks, accountSummary,
    TEMPLATE_CSV, savedWhen, snapshotSource, cashForm, cashBody,
    tradeLabel, journalRows, contractKey, tradeHref, isOption, usable, EPS,
    brokerAccountFor, splitByBroker, twsSaves, accountRows, gather, totalsOf, cashState };
});
