// Pure view-model helpers for the Portfolio trade cards (sections.js draws them). No DOM, no network:
// how one leg reads, a trade's title, its nearest expiry and whether it was a debit or a credit.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioCards = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_MS = 86400000;
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  const day = (iso) => String(iso || '').slice(0, 10);

  /** "13 Nov 26" from an ISO date, or '' when it is not one. */
  function dateText(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day(iso));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}` : '';
  }

  /**
   * One position row as the card shows it: side (Long/Short) and an unsigned quantity, so a
   * short never needs a minus sign, plus what it is ("680 Call", "AAPL shares").
   */
  function legView(row) {
    const option = row.sec_type === 'OPT';
    const kind = option ? (row.kind === 'put' ? 'put' : 'call') : 'stock';
    const expiry = option && row.expiry ? day(row.expiry) : null;
    return {
      side: row.qty < 0 ? 'short' : 'long',
      qty: Math.abs(row.qty),
      kind,
      what: option ? `${row.strike} ${kind === 'put' ? 'Put' : 'Call'}` : `${String(row.symbol || '').toUpperCase()} shares`,
      expiry,
      expiryText: expiry ? dateText(expiry) : '',
      price: row.avg_cost,
    };
  }

  /** "bull_put_spread" as "Bull put spread"; "Trade" when the journal gave none. */
  function strategyTitle(strategy) {
    const words = typeof strategy === 'string' ? strategy.replace(/_/g, ' ').trim() : '';
    return words ? words[0].toUpperCase() + words.slice(1) : 'Trade';
  }

  const utcDay = (iso) => {
    const [y, m, d] = day(iso).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };

  /**
   * The nearest expiry not yet past (else the latest past one) among a trade's option legs, with
   * the days to it and how many other expiries there are. null when it holds no options.
   * @param {object[]} rows position rows
   * @param {string} today YYYY-MM-DD (passed in so tests need no clock)
   */
  function expirySummary(rows, today) {
    const expiries = [...new Set((Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.sec_type === 'OPT' && r.expiry).map((r) => day(r.expiry)))].sort();
    if (!expiries.length) return null;
    const upcoming = expiries.filter((e) => e >= today);
    const pick = upcoming.length ? upcoming[0] : expiries[expiries.length - 1];
    return { expiry: pick, text: dateText(pick), days: Math.round((utcDay(pick) - utcDay(today)) / DAY_MS),
      more: expiries.length - 1 };
  }

  /** "7d", "today" or "expired". */
  function dteText(days) {
    if (days < 0) return 'expired';
    return days === 0 ? 'today' : `${days}d`;
  }

  /** Net cost as a word and an amount: paying is a Debit, receiving a Credit (not a profit or loss). */
  function costWord(net) {
    if (!finite(net) || net === 0) return { word: 'Flat', amount: 0 };
    return { word: net > 0 ? 'Debit' : 'Credit', amount: Math.abs(net) };
  }

  return { legView, strategyTitle, expirySummary, dteText, costWord, dateText };
});
