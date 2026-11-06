/* Fetch wrapper for the {ok, data, error} envelope. Failures show a toast and then throw,
 * so callers can restore UI state; nothing is swallowed. */
(function (root) {
  "use strict";

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function messageFrom(body, status) {
    if (body && typeof body.error === "string" && body.error) return body.error;
    if (body && body.detail) {
      if (typeof body.detail === "string") return body.detail;
      if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg || String(d)).join("; ");
    }
    return `Request failed (HTTP ${status})`;
  }

  async function request(method, path, body, { quiet = false } = {}) {
    const opts = { method, headers: { Accept: "application/json" } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      const e = new ApiError("Cannot reach the Trade Logger server. Is it still running?", 0);
      if (!quiet) UI.toast(e.message, "err");
      throw e;
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      payload = null;
    }
    if (!res.ok || !payload || payload.ok === false) {
      const e = new ApiError(messageFrom(payload, res.status), res.status);
      if (!quiet) UI.toast(e.message, "err");
      throw e;
    }
    return payload.data;
  }

  root.Api = {
    ApiError,
    get: (p, o) => request("GET", p, undefined, o),
    post: (p, b, o) => request("POST", p, b === undefined ? {} : b, o),
    patch: (p, b, o) => request("PATCH", p, b, o),
    del: (p, o) => request("DELETE", p, undefined, o),
    upload: (p, form, o) => request("POST", p, form, o),
  };

  /** Run a page's async init; any error is shown (the toast was already raised by request). */
  root.boot = function boot(fn) {
    document.addEventListener("DOMContentLoaded", () => {
      UI.header();
      Promise.resolve()
        .then(fn)
        .catch((err) => {
          if (!(err instanceof ApiError)) UI.toast(`Page error: ${err.message || err}`, "err");
        });
    });
  };
})(window);
