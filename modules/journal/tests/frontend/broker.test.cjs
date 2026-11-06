const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../../static/js/broker.js");

test("connected status", () => {
  const v = B.statusView({ ibkr: "connected", reason: null });
  assert.equal(v.connected, true);
  assert.match(v.message, /read-only/);
});

test("disconnected status keeps the broker's reason", () => {
  const v = B.statusView({ ibkr: "disconnected", reason: "not connected to TWS; press Connect IBKR" });
  assert.equal(v.connected, false);
  assert.equal(v.message, "not connected to TWS; press Connect IBKR");
});

test("market service offline is not connected", () => {
  const v = B.statusView({ sidecar: "offline", ibkr: "connected", reason: "python missing" });
  assert.equal(v.connected, false);
  assert.equal(v.message, "python missing");
});

test("missing status body", () => {
  assert.deepEqual(B.statusView(null), { connected: false, known: false, message: "TWS status unknown." });
});

test("failure text prefers the server message", () => {
  assert.equal(B.failureText(409, { error: "not connected to TWS" }), "not connected to TWS");
  assert.equal(B.failureText(409, {}), "Not connected to TWS.");
  assert.match(B.failureText(0, null), /Cannot reach/);
  assert.match(B.failureText(404, null), /through OptionDash/);
  assert.equal(B.failureText(500, null), "TWS request failed (HTTP 500)");
});

test("connect reply that stayed disconnected is a failure", () => {
  assert.equal(B.connectFailure({ ibkr: "connected" }), "");
  assert.equal(B.connectFailure({ ibkr: "disconnected", reason: "refused" }), "refused");
  assert.equal(B.connectFailure({ ibkr: "disconnected" }), "TWS did not connect.");
});

test("calls hit /api/broker and map errors", async () => {
  const seen = [];
  const ok = async (url, opts) => {
    seen.push([opts.method, url]);
    return { ok: true, status: 200, json: async () => ({ ibkr: "connected" }) };
  };
  assert.deepEqual(await B.connect(ok), { ibkr: "connected" });
  await B.status(ok);
  await B.disconnect(ok);
  assert.deepEqual(seen, [["POST", "/api/broker/connect"], ["GET", "/api/broker/status"], ["POST", "/api/broker/disconnect"]]);

  const conflict = async () => ({ ok: false, status: 409, json: async () => ({ error: "nope" }) });
  await assert.rejects(B.status(conflict), (e) => e instanceof B.BrokerError && e.status === 409 && e.message === "nope");
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(B.status(down), (e) => e.status === 0);
  const notJson = async () => ({ ok: false, status: 502, json: async () => { throw new Error("x"); } });
  await assert.rejects(B.status(notJson), (e) => /through OptionDash/.test(e.message));
});

test("announce dispatches the shared event", () => {
  const events = [];
  global.CustomEvent = class { constructor(type) { this.type = type; } };
  B.announce({ dispatchEvent: (e) => events.push(e.type) });
  assert.deepEqual(events, ["broker:changed"]);
  delete global.CustomEvent;
});

test("POSTs carry a JSON body the gateway accepts; GETs carry none", async () => {
  const seen = [];
  const ok = async (url, opts) => {
    seen.push(opts);
    return { ok: true, status: 200, json: async () => ({ ibkr: "connected" }) };
  };
  await B.connect(ok);
  await B.disconnect(ok);
  await B.status(ok);
  for (const post of seen.slice(0, 2)) {
    assert.equal(post.method, "POST");
    assert.equal(post.headers["Content-Type"], "application/json");
    assert.equal(post.body, "{}");
  }
  assert.equal(seen[2].body, undefined);
  assert.equal(seen[2].headers["Content-Type"], undefined);
  assert.ok(seen.every((o) => o.signal), "every call can be aborted");
});

test("a hung gateway times out with a clear message", async () => {
  const hang = (_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0); // fire the abort at once
  try {
    await assert.rejects(B.status(hang), (e) => e.status === 0 && /timed out/.test(e.message));
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(B.TIMEOUT_MS >= 40000, "longer than the gateway's own bounds");
});

test("announce and setBusy tag their events with the journal as source", () => {
  const events = [];
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  const t = { dispatchEvent: (e) => events.push([e.type, e.detail]) };
  B.announce(t);
  B.setBusy(true, t);
  B.setBusy(false, t);
  delete global.CustomEvent;
  assert.deepEqual(events, [
    ["broker:changed", { source: "journal" }],
    ["broker:busy", { source: "journal", busy: true }],
    ["broker:busy", { source: "journal", busy: false }],
  ]);
});

test("othersBusy tracks other components and ignores our own events", () => {
  let s = new Set();
  s = B.othersBusy(s, { source: "nav", busy: true });
  assert.deepEqual([...s], ["nav"]);
  const before = s;
  s = B.othersBusy(s, { source: "journal", busy: true });
  assert.deepEqual([...s], ["nav"]);
  assert.notEqual(s, before, "returns a new set");
  s = B.othersBusy(s, { source: "nav", busy: false });
  assert.equal(s.size, 0);
  assert.equal(B.othersBusy(s, null).size, 0);
});

test("only a 409 counts as not connected", () => {
  assert.equal(B.isNotConnected({ status: 409 }), true);
  assert.equal(B.isNotConnected({ status: 504 }), false);
  assert.equal(B.isNotConnected(null), false);
});
