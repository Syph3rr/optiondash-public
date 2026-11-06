// Pure helpers for the Title page. No DOM and no network, so Node tests can load this file
// directly (see tests/frontend/NAME.test.cjs). The page code is page.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NAME = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Turn the API rows into what the page shows. Never change the input. */
  function summarise(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return { rows: list.map((r) => ({ ...r })), total: list.length };
  }

  return { summarise };
});
