/* The platform's shared TWS connection, as the Trades-page import panel sees it. window.Broker / Node.
 * /api/broker/* lives on the gateway (not the journal): success bodies are raw JSON and
 * errors are {error}. Nothing here polls or connects on its own. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Broker = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BASE = "/api/broker";
  const EVENT = "broker:changed";
  const STATUS_EVENT = "broker:status"; // from the nav: detail {source, status}
  const BUSY_EVENT = "broker:busy"; // detail {source, busy}
  const SOURCE = "journal";
  const TIMEOUT_MS = 45000;
  const text = (x) => (typeof x === "string" && x.trim() ? x.trim() : "");

  /** Page view of a /api/broker/status body ({ibkr, reason, sidecar?}). */
  function statusView(body) {
    if (!body || typeof body !== "object") {
      return { connected: false, known: false, message: "TWS status unknown." };
    }
    if (body.sidecar && body.sidecar !== "online") {
      return { connected: false, known: true, message: text(body.reason) || "The market data service is offline." };
    }
    const connected = body.ibkr === "connected";
    return {
      connected,
      known: true,
      message: connected ? "Connected to TWS (read-only), shared by the whole app."
        : text(body.reason) || "Not connected to TWS. Press Connect.",
    };
  }

  /** Error text for a failed broker reply: the server's own message when it gave one. */
  function failureText(httpStatus, body) {
    const msg = body && (body.error || body.message);
    if (text(msg)) return text(msg);
    if (httpStatus === 409) return "Not connected to TWS.";
    if (httpStatus === 0) return "Cannot reach OptionDash. Is it still running?";
    if (httpStatus === 404 || httpStatus === 502 || httpStatus === 503) {
      return "The shared TWS connection is unavailable. Open the journal through OptionDash.";
    }
    return `TWS request failed (HTTP ${httpStatus})`;
  }

  /** A connect reply that came back 200 but left TWS disconnected is still a failure. */
  function connectFailure(body) {
    if (body && body.ibkr && body.ibkr !== "connected") return text(body.reason) || "TWS did not connect.";
    return "";
  }

  class BrokerError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  /** Fetch options for one broker call. The gateway's connect/disconnect routes only accept a
   *  JSON body, so POSTs always carry one. */
  function requestInit(method, signal) {
    const headers = { Accept: "application/json" };
    const init = { method, headers };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = "{}";
    }
    if (signal) init.signal = signal;
    return init;
  }

  async function call(method, path, fetchFn) {
    const doFetch = fetchFn || (typeof fetch === "function" ? fetch : null);
    // The gateway bounds every broker call itself; this only guards against a hung gateway.
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), TIMEOUT_MS) : null;
    let res;
    try {
      res = await doFetch(BASE + path, requestInit(method, abort && abort.signal));
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      throw new BrokerError(timedOut ? "TWS request timed out; try again." : failureText(0, null), 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok) throw new BrokerError(failureText(res.status, body), res.status);
    return body;
  }

  const target = (t) => t || (typeof window !== "undefined" ? window : null);
  function emit(name, detail, t) {
    const w = target(t);
    if (w && typeof w.dispatchEvent === "function" && typeof CustomEvent === "function") {
      w.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  /** Tell the shared nav (and any other listener) that the connection may have changed. */
  function announce(t) {
    emit(EVENT, { source: SOURCE }, t);
  }

  /** Tell other components that this page is mid connect/disconnect (they disable theirs). */
  function setBusy(on, t) {
    emit(BUSY_EVENT, { source: SOURCE, busy: Boolean(on) }, t);
  }

  /** Busy sources other than this page, updated from a broker:busy event. Returns a new set. */
  function othersBusy(current, detail) {
    const next = new Set(current);
    if (!detail || !detail.source || detail.source === SOURCE) return next;
    if (detail.busy) next.add(detail.source);
    else next.delete(detail.source);
    return next;
  }

  /** Whether a failed journal or broker call means TWS is not connected (so the chip should re-read). */
  const isNotConnected = (err) => Boolean(err && err.status === 409);

  return {
    EVENT,
    STATUS_EVENT,
    BUSY_EVENT,
    SOURCE,
    TIMEOUT_MS,
    BrokerError,
    statusView,
    failureText,
    connectFailure,
    requestInit,
    announce,
    setBusy,
    othersBusy,
    isNotConnected,
    status: (f) => call("GET", "/status", f),
    connect: (f) => call("POST", "/connect", f),
    disconnect: (f) => call("POST", "/disconnect", f),
  };
});
