// Portfolio page: one section per shown account, its open positions as one card per journal trade
// (grouping.js decides the groups, cardview.js how a card reads), plus the small DOM helpers the
// other page scripts share. Server text only reaches textContent; links are built from whole-number ids.
(function () {
  'use strict';
  const P = window.Portfolio;
  const G = window.PortfolioGroups;
  const C = window.PortfolioCards;
  const TYPE_LABEL = { ibkr: 'IBKR', paper: 'Paper', other: 'Other' };
  const NONE = 'none'; // the key of the "Not in journal" group

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  const money = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const signed = (v) => (v > 0 ? `+${money(v)}` : money(v));
  const costSign = (v) => (v > 0 ? 'neg' : v < 0 ? 'pos' : ''); // paying is a cost, receiving a credit
  const pnlSign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const cell = (text, cls) => el('td', cls || '', text);
  const num = (text, cls) => cell(text, `r num ${cls || ''}`.trim());
  const empty = (text) => el('div', 'pf-empty', text);
  const fx = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function link(href, text, cls) {
    const a = el('a', cls || '', text);
    a.href = href;
    return a;
  }

  /** "$Δ 1,234 · Θ -12/d · V 30", or '' when nothing was priced. */
  function greeksText(g) {
    if (!g) return '';
    return `$Δ ${fx(g.dollarDelta)} · Θ ${fx(g.theta)}/d · V ${fx(g.vega)}`;
  }

  // ---- small pieces

  function pill(label, value, cls) {
    const p = el('span', 'pf-pill');
    p.append(el('span', 'k', label), el('span', `v num ${cls || ''}`.trim(), value));
    return p;
  }

  /** P&L and the Greeks as labelled figures, once Load Greeks has priced them. */
  function statPills(stats) {
    const box = el('span', 'pf-pills');
    if (!stats) return box;
    if (stats.pnl !== null && stats.pnl !== undefined) box.append(pill('P&L', signed(stats.pnl), pnlSign(stats.pnl)));
    if (stats.greeks) {
      const g = stats.greeks;
      box.append(pill('$Δ', fx(g.dollarDelta), ''), pill('Θ/day', fx(g.theta), ''), pill('Vega', fx(g.vega), ''));
    }
    if (stats.unpriced) box.append(pill('Unpriced', String(stats.unpriced), 'warn'));
    return box;
  }

  /** "Debit $32,540" / "Credit $490": what was paid or received, not a profit or loss. */
  function costChip(net) {
    const c = C.costWord(net);
    const chip = el('span', 'pf-cost');
    chip.title = 'Paid (debit) or received (credit) to open, at average cost';
    chip.append(el('span', 'k', c.word));
    if (c.amount) chip.append(el('span', 'v num', money(c.amount)));
    return chip;
  }

  /** The "Log as trade" button: leaves the position in the New trade hand-off, then opens the form. */
  function logLink(row, accountId) {
    const a = link(G.NEW_TRADE_URL, 'Log as trade', 'btn pf-log');
    a.title = 'Open New trade prefilled with this position';
    a.addEventListener('click', () => {
      try {
        window.sessionStorage.setItem(G.PREFILL_KEY, JSON.stringify(G.prefillFor(row, accountId)));
      } catch (e) {
        // Storage blocked: the form still opens, just empty.
      }
    });
    return a;
  }

  // ---- one leg

  function legRow(r, ctx) {
    const v = C.legView(r);
    const q = ctx.live && ctx.live.markFor(r);
    const pnl = q ? P.unrealised(r, q) : null;
    const price = Number.isFinite(v.price) ? v.price.toFixed(2) : '—';
    const row = el('div', 'pf-leg');
    const what = el('span', 'pf-what');
    const main = el('span', 'pf-what-main');
    if (v.expiryText) main.append(el('span', 'pf-exp', v.expiryText), ' ');
    main.append(el('span', 'pf-strike', v.what));
    what.append(main);
    // Priced: avg cost and mark sit under the contract, so the row needs only one figure column (P&L).
    if (ctx.live) what.append(el('span', 'pf-what-sub num', `avg ${price} · mark ${q ? q.mark.toFixed(2) : '—'}`));
    row.append(el('span', `pf-side ${v.side}`, v.side === 'short' ? 'Short' : 'Long'),
      el('span', 'pf-qty num', fx(v.qty, v.qty % 1 ? 2 : 0)), what,
      ctx.live ? el('span', `pf-lp num ${pnlSign(pnl)}`, pnl === null ? '—' : signed(pnl)) : el('span', 'pf-px num', price));
    if (ctx.unmatched) row.append(logLink(r, ctx.accountId));
    return row;
  }

  function legsHead(ctx) {
    const h = el('div', 'pf-leg pf-leg-h');
    ['', 'Qty', 'Contract', ctx.live ? 'P&L' : 'Avg cost'].forEach((t, i) => h.append(el('span', i === 1 || i === 3 ? 'r' : '', t)));
    if (ctx.unmatched) h.append(el('span'));
    return h;
  }

  function legsBox(rows, ctx) {
    const box = el('div', `pf-legs${ctx.live ? ' live' : ''}${ctx.unmatched ? ' act' : ''}`);
    box.append(legsHead(ctx), ...rows.map((r) => legRow(r, ctx)));
    return box;
  }

  // ---- one card

  function cardShell(titleNode, subText, net, extraClass) {
    const card = el('article', `pf-card${extraClass ? ` ${extraClass}` : ''}`);
    const head = el('div', 'pf-card-h');
    const left = el('div', 'pf-card-t');
    left.append(titleNode, el('div', 'pf-sub', subText));
    head.append(left);
    if (net !== null) head.append(costChip(net));
    card.append(head);
    return card;
  }

  function subText(group, today) {
    const parts = [`#${group.trade_id}`];
    const ex = C.expirySummary(group.rows.length ? group.rows : group.missing, today);
    if (ex) {
      parts.push(`${ex.text} · ${C.dteText(ex.days)}`);
      if (ex.more) parts.push(`${ex.more} more expir${ex.more === 1 ? 'y' : 'ies'}`);
    }
    return parts.join(' · ');
  }

  function warnLine(m, group) {
    const w = el('div', 'pf-warn');
    w.append(el('span', 'pf-warn-i', '⚠'),
      link(group.href, `${m.label} ×${m.qty}: journal says open, broker doesn't hold it`));
    return w;
  }

  function tradeCard(group, ctx, today) {
    const title = el('div', 'pf-title-row');
    title.append(link(group.href, C.strategyTitle(group.strategy), 'pf-title'), el('span', 'pf-und', group.underlying));
    const card = cardShell(title, subText(group, today), group.rows.length ? group.net : null);
    if (group.rows.length) card.append(legsBox(group.rows, ctx));
    group.missing.forEach((m) => card.append(warnLine(m, group)));
    const stats = ctx.live && ctx.live.group(ctx.accountId, group.trade_id);
    if (stats && (stats.greeks || stats.pnl !== null || stats.unpriced)) {
      const foot = el('div', 'pf-card-f');
      foot.append(statPills(stats));
      card.append(foot);
    }
    return card;
  }

  function unmatchedCard(rows, ctx) {
    const title = el('div', 'pf-title-row');
    title.append(el('span', 'pf-title notin', 'Not in journal'));
    const net = rows.reduce((s, r) => s + r.cost, 0);
    const card = cardShell(title, 'Held at the broker, but no open journal trade accounts for it', net, 'pf-card-notin');
    card.append(legsBox(rows, { ...ctx, unmatched: true }));
    const stats = ctx.live && ctx.live.group(ctx.accountId, NONE);
    if (stats && (stats.greeks || stats.pnl !== null || stats.unpriced)) {
      const foot = el('div', 'pf-card-f');
      foot.append(statPills(stats));
      card.append(foot);
    }
    return card;
  }

  function cardsGrid(view, live) {
    const ctx = { live, accountId: view.account.id };
    const today = todayIso();
    const grid = el('div', 'pf-cards');
    grid.append(...view.grouped.groups.map((g) => tradeCard(g, ctx, today)));
    if (view.grouped.unmatched.length) grid.append(unmatchedCard(view.grouped.unmatched, ctx));
    return grid;
  }

  // ---- account section

  function header(view, live) {
    const h = el('div', 'pf-acct-h');
    const a = view.account;
    h.append(el('b', 'pf-acct-name', a.name), el('span', 'pf-badge', TYPE_LABEL[a.type] || a.type),
      el('span', `pf-badge src-${view.source}`, view.sourceLabel));
    const trades = view.grouped.groups.length;
    const legs = view.rows.length;
    // Broker accounts with no journal trade behind them are just legs: "0 trades" would only confuse.
    if (trades || legs) h.append(el('span', 'pf-muted', trades ? `${plural(trades, 'trade')} · ${plural(legs, 'leg')}` : plural(legs, 'leg')));
    const cash = P.accountSummary(view.cash);
    if (cash) {
      const fmt = (v) => (Number.isFinite(v) ? (cash.currency === 'USD' ? money(v) : `${fx(v)} ${cash.currency}`) : '—');
      h.append(el('span', 'pf-muted', `Cash ${fmt(cash.cash)} · Net liq ${fmt(cash.netLiquidation)}`));
    }
    h.append(el('span', 'grow'));
    const totals = live && live.account(a.id);
    if (totals) h.append(statPills(totals));
    if (view.rows.length) h.append(costChip(P.summarise(view.rows).totals.net));
    return h;
  }

  function emptyState(view, onUpload) {
    const box = el('div', 'pf-acct-empty');
    if (view.source === 'none') {
      const ibkr = view.account.type === 'ibkr';
      box.append(el('span', '', ibkr ? 'TWS is not connected and nothing is saved for this account.' : 'No CSV uploaded for this account yet.'));
      const b = el('button', 'btn', 'Upload a CSV');
      b.type = 'button';
      b.addEventListener('click', () => onUpload(view.account.id));
      box.append(b);
      if (view.trades.length) {
        box.append(el('span', 'pf-muted', `${view.trades.length} open journal trade${view.trades.length === 1 ? '' : 's'} not checked against the broker.`));
      }
      return box;
    }
    box.append(el('span', '', view.source === 'journal' ? 'No open trades.' : 'No open positions.'));
    return box;
  }

  /**
   * Draw every shown account.
   * @param {HTMLElement} host
   * @param {object[]} views accountRows() results, each with `grouped` (groupByTrade)
   * @param {{live: object|null, onUpload: function(number)}} opts
   */
  function render(host, views, opts) {
    host.replaceChildren(...views.map((view) => {
      const sec = el('section', 'card pf-acct');
      const hasRows = view.grouped.groups.length || view.grouped.unmatched.length;
      sec.append(header(view, opts.live), hasRows ? cardsGrid(view, opts.live) : emptyState(view, opts.onUpload));
      return sec;
    }));
  }

  window.PortfolioSections = { render, NONE, dom: { el, money, costSign, cell, num, empty, fx, greeksText } };
})();
