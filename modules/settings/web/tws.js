// Settings > Interactive Brokers: the pure view logic for the TWS connection control.
// It reuses the nav chip's states (ODNav.chipView) so the card and the chip can never
// disagree, and adds what the card needs: a message and one enabled button at most.
// Browser: window.SettingsTws. Node: module.exports (for tests).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SettingsTws = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /**
   * @param {{status?: object|null, busy?: 'connect'|'disconnect'|null, error?: string,
   *          locked?: boolean}} state  as for ODNav.chipView (locked: another component is busy)
   * @param {Function} chipView  ODNav.chipView
   * @returns {{tone: string, connected: boolean, message: string,
   *            connect: {disabled: boolean}, disconnect: {disabled: boolean}}}
   *   At most one of the two buttons is ever enabled.
   */
  function twsView(state, chipView) {
    const v = chipView(state || {});
    const action = v.button.hidden || v.button.disabled ? null : v.button.action;
    return {
      tone: v.tone,
      connected: !!(state && state.status && state.status.ibkr === 'connected' && v.tone !== 'busy'
        && (!state.status.sidecar || state.status.sidecar === 'online')),
      message: v.title,
      connect: { disabled: action !== 'connect' },
      disconnect: { disabled: action !== 'disconnect' },
    };
  }

  return { twsView };
});
