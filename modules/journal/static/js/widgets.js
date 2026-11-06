// Home cards from the journal: the analytics that used to be the Dashboard page.
// The card definitions and renderers live in dashboard.js (JournalDashboard.cards); this file
// only puts them on Home. Served by the journal service, so they vanish if it is down.
// Every card shows journal data, so each opts in to the account filter (`accounts: true`):
// Home re-mounts them when the selection changes, and their URLs go through withAccounts.
(function () {
  'use strict';
  JournalDashboard.cards.forEach((card) => ODWidgets.register({ ...card, accounts: true }));
})();
