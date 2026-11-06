/* Pure helpers for "Log as trade": the analyser leaves a strategy in sessionStorage under
   KEY and opens the Trades page with ?new=1&from=analyser; the New trade form reads it once, validates it
   here and fills itself in. Shape:
   {underlying, strategy?, opened_at?, underlying_entry?, iv_entry?,
    legs: [{kind: "call"|"put"|"stock", side: "buy"|"sell", qty, strike?, expiry?, price?}]} */
(function (root) {
  "use strict";

  const KEY = "journal.prefill";
  const MAX_LEGS = 20;
  const SYMBOL = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const optionalPositive = (v, what) => {
    if (v === undefined || v === null || v === "") return null;
    if (!isNum(v) || v <= 0) throw new Error(`${what} must be a positive number.`);
    return v;
  };

  function parseLeg(raw, i) {
    const n = i + 1;
    if (!raw || typeof raw !== "object") throw new Error(`Leg ${n} is not an object.`);
    if (!["call", "put", "stock"].includes(raw.kind)) throw new Error(`Leg ${n}: kind must be call, put or stock.`);
    if (!["buy", "sell"].includes(raw.side)) throw new Error(`Leg ${n}: side must be buy or sell.`);
    if (!isNum(raw.qty) || raw.qty <= 0) throw new Error(`Leg ${n}: quantity must be a positive number.`);
    const price = raw.price === undefined || raw.price === null ? null : raw.price;
    if (price !== null && (!isNum(price) || price < 0)) throw new Error(`Leg ${n}: price must be zero or more.`);
    if (raw.kind === "stock") return { kind: "stock", side: raw.side, qty: raw.qty, strike: null, expiry: null, price };
    if (!isNum(raw.strike) || raw.strike <= 0) throw new Error(`Leg ${n}: an option needs a positive strike.`);
    if (typeof raw.expiry !== "string" || !ISO_DAY.test(raw.expiry)) throw new Error(`Leg ${n}: an option needs an expiry date (YYYY-MM-DD).`);
    return { kind: raw.kind, side: raw.side, qty: raw.qty, strike: raw.strike, expiry: raw.expiry, price };
  }

  /** Validate a prefill (object or JSON text). Returns a clean copy or throws a readable Error. */
  function parsePrefill(input) {
    let raw = input;
    if (typeof input === "string") {
      try { raw = JSON.parse(input); } catch (_) { throw new Error("The analyser's strategy could not be read."); }
    }
    if (!raw || typeof raw !== "object") throw new Error("The analyser's strategy could not be read.");
    const underlying = String(raw.underlying || "").trim().toUpperCase();
    if (!SYMBOL.test(underlying)) throw new Error("The strategy has no valid underlying symbol.");
    if (!Array.isArray(raw.legs) || !raw.legs.length) throw new Error("The strategy has no legs.");
    if (raw.legs.length > MAX_LEGS) throw new Error(`A trade can have at most ${MAX_LEGS} legs.`);
    const opened = raw.opened_at && ISO_DAY.test(String(raw.opened_at)) ? String(raw.opened_at) : null;
    return {
      underlying,
      strategy: typeof raw.strategy === "string" && raw.strategy ? raw.strategy : null,
      opened_at: opened,
      // The account a Portfolio position came from (Log as trade); the analyser sends none.
      account_id: Number.isInteger(raw.account_id) && raw.account_id > 0 ? raw.account_id : null,
      underlying_entry: optionalPositive(raw.underlying_entry, "Underlying price"),
      iv_entry: optionalPositive(raw.iv_entry, "IV"),
      legs: raw.legs.map(parseLeg),
    };
  }

  /** Signed legs for Strategies.guessStrategy. */
  const signedLegs = (p) => p.legs.map((l) => ({ kind: l.kind, strike: l.strike, expiry: l.expiry, qty: l.side === "buy" ? l.qty : -l.qty }));

  /** Strategy id to select: the analyser's if the journal knows it, otherwise a guess. */
  function chooseStrategy(p, known, guess) {
    return p.strategy && known.includes(p.strategy) ? p.strategy : guess(signedLegs(p));
  }

  /** Read once and remove (so a reload doesn't refill). Returns null when nothing is stored. */
  function take(storage) {
    let text = null;
    try {
      text = storage.getItem(KEY);
      storage.removeItem(KEY);
    } catch (_) {
      return null;  // storage blocked: behave as if nothing was passed
    }
    return text === null ? null : parsePrefill(text);
  }

  const api = { KEY, parsePrefill, signedLegs, chooseStrategy, take };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Prefill = api;
})(typeof window !== "undefined" ? window : globalThis);
