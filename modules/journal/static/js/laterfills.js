/* Later closes and adjustments typed on the New trade form. Pure: no DOM. window.LaterFills / Node.
 *
 * Opening legs: [{key, kind, strike, expiry, qty (signed), price}] (see openingLegs).
 * Blocks (one per later event): [{event, date, fills: [row]}], where a row is
 *   {key, include, side: "buy"|"sell", qty (> 0), price, commission, auto}
 * and `auto` means the qty is still the prefilled one (so it may be re-prefilled).
 * Blocks are applied oldest date first; blocks on the same date keep their order,
 * which is how the server writes them. */
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const api = factory(isNode ? require("./fills.js") : root.Fills);
  if (isNode) module.exports = api;
  else root.LaterFills = api;
})(typeof self !== "undefined" ? self : this, function (Fills) {
  "use strict";

  const EPS = 1e-9;
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const signed = (row) => (row.side === "buy" ? row.qty : -row.qty);
  const multiplier = (leg) => (leg.kind === "stock" ? 1 : 100);
  const counts = (row) => row.include && isNum(row.qty) && row.qty > 0;

  function legKey(leg) {
    return leg.kind === "stock" ? "stock" : `${leg.kind}|${Number(leg.strike)}|${leg.expiry || ""}`;
  }

  /**
   * Opening legs from the form's draft rows ({side, qty, kind, strike, expiry, price}).
   * The same contract on two rows is merged. Null while any row is incomplete.
   */
  function openingLegs(drafts) {
    const complete = (d) => d && isNum(d.qty) && d.qty > 0
      && (d.kind === "stock" || (isNum(d.strike) && d.strike > 0 && !!d.expiry));
    if (!drafts || !drafts.length || !drafts.every(complete)) return null;
    return drafts.reduce((legs, d) => {
      const key = legKey(d);
      const qty = d.side === "buy" ? d.qty : -d.qty;
      const hit = legs.find((l) => l.key === key);
      if (!hit) {
        return [...legs, { key, kind: d.kind, strike: d.kind === "stock" ? null : d.strike,
          expiry: d.kind === "stock" ? null : d.expiry, qty, price: d.price }];
      }
      const merged = round(hit.qty + qty);
      return legs.map((l) => (l === hit ? { ...l, qty: merged, price: averagePrice(hit.qty, hit.price, qty, d.price) } : l));
    }, []);
  }

  /**
   * Average price after adding `x` at `price` to `q` held at `avg` (the ledger's average cost):
   * adding weights the average, reducing keeps it, crossing zero restarts at `price`.
   */
  function averagePrice(q, avg, x, price) {
    if (!isNum(avg) || !isNum(price)) return null;
    const next = round(q + x);
    const reducing = Math.abs(q) > EPS && (q > 0) !== (x > 0);
    if (!reducing) return Math.abs(next) > EPS ? (avg * Math.abs(q) + price * Math.abs(x)) / Math.abs(next) : avg;
    const flipped = Math.abs(next) > EPS && (next > 0) !== (q > 0);
    return flipped ? price : avg;
  }

  /** Block indices, oldest date first (undated last), ties in the order given. */
  function chronological(blocks) {
    const day = (b) => (ISO_DAY.test(b.date || "") ? b.date : "￿");
    return blocks.map((b, i) => i).sort((a, b) => {
      const da = day(blocks[a]), db = day(blocks[b]);
      return da < db ? -1 : da > db ? 1 : a - b;
    });
  }

  const startingQty = (legs) => new Map(legs.map((l) => [l.key, l.qty]));

  function applyBlock(open, block) {
    const next = new Map(open);
    block.fills.filter(counts).forEach((r) => {
      if (next.has(r.key)) next.set(r.key, round(next.get(r.key) + signed(r)));
    });
    return next;
  }

  /** Open qty per leg key before each block (indexed like `blocks`) and after all of them. */
  function walk(legs, blocks) {
    const before = new Array(blocks.length);
    const after = chronological(blocks).reduce((open, i) => {
      before[i] = open;
      return applyBlock(open, blocks[i]);
    }, startingQty(legs));
    return { before, after };
  }

  /** Rows that close whatever is open (unticked when nothing is). */
  function closingRows(legs, open) {
    return legs.map((l) => {
      const left = open.get(l.key) || 0;
      return { key: l.key, include: Math.abs(left) > EPS, side: left > 0 ? "sell" : "buy",
        qty: Math.abs(left), price: null, commission: null, auto: true };
    });
  }

  /** Rows for a newly added block: close what is still open after every existing block. */
  function newBlockRows(legs, blocks) {
    return closingRows(legs, walk(legs, blocks).after);
  }

  /**
   * Re-fit blocks to changed opening legs. Typed values carry over where the leg still
   * matches by contract (or by position when the number of legs is unchanged); prefilled
   * quantities are worked out again.
   */
  function refit(newLegs, blocks, oldLegs) {
    const samePositions = oldLegs && oldLegs.length === newLegs.length;
    const out = new Array(blocks.length);
    chronological(blocks).reduce((open, i) => {
      const old = blocks[i].fills;
      const defaults = closingRows(newLegs, open);
      const fills = defaults.map((d, j) => {
        const prev = old.find((r) => r.key === d.key)
          || (samePositions && oldLegs[j] && old.find((r) => r.key === oldLegs[j].key));
        if (!prev) return d;
        const carried = { ...prev, key: d.key };
        return prev.auto ? { ...carried, side: d.side, qty: d.qty, auto: true } : carried;
      });
      out[i] = { ...blocks[i], fills };
      return applyBlock(open, out[i]);
    }, startingQty(newLegs));
    return out;
  }

  /** Per leg, the open qty at the start and after each block that touches it: [10, 6, 0]. */
  function ladder(legs, blocks) {
    const order = chronological(blocks);
    return legs.map((l) => {
      const steps = order.reduce((acc, i) => {
        const moved = blocks[i].fills.filter((r) => r.key === l.key && counts(r));
        if (!moved.length) return acc;
        const last = acc[acc.length - 1];
        return [...acc, round(moved.reduce((q, r) => q + signed(r), last))];
      }, [l.qty]);
      return { key: l.key, steps };
    });
  }

  const EVENT_NAMES = { close: "Close", expire: "Expire", assign: "Assignment", adjust: "Adjust", roll: "Roll" };

  function blockLabel(block, i) {
    return `${EVENT_NAMES[block.event] || block.event} #${i + 1}${ISO_DAY.test(block.date || "") ? ` (${block.date})` : ""}`;
  }

  function rowErrors(rows) {
    const errors = [];
    rows.forEach((r) => {
      if (!(isNum(r.qty) && r.qty > 0)) errors.push("quantity must be above 0");
      if (!isNum(r.price)) errors.push("enter the fill price");
      else if (r.price < 0) errors.push("fill price must be 0 or more");
      if (r.commission !== null && r.commission !== undefined && !(isNum(r.commission) && r.commission >= 0)) {
        errors.push("commission must be 0 or more");
      }
    });
    return [...new Set(errors)];
  }

  function blockErrors(block, open, legs, openedAt) {
    if (!ISO_DAY.test(block.date || "")) return ["pick the date"];
    const errors = openedAt && block.date < openedAt ? [`date is before the trade was opened (${openedAt})`] : [];
    const rows = block.fills.filter((r) => r.include);
    if (!rows.length) return [...errors, "tick at least one leg"];
    const bad = rowErrors(rows);
    if (bad.length) return [...errors, ...bad];
    const asLegs = legs.map((l) => ({ ...l, id: l.key, net_qty: open.get(l.key) || 0 }));
    const fills = rows.map((r) => ({ leg_id: r.key, qty: signed(r) }));
    return [...errors, ...Fills.checkFills(block.event, asLegs, fills).errors];
  }

  /**
   * Check every block against what is open before it, mirroring the server.
   * Returns {errors: [msg]} with each message prefixed by its block.
   */
  function validate(legs, blocks, openedAt) {
    const { before } = walk(legs, blocks);
    const errors = blocks.flatMap((b, i) =>
      blockErrors(b, before[i], legs, openedAt).map((msg) => `${blockLabel(b, i)}: ${msg}`));
    return { errors };
  }

  /** The `events` part of the create payload: legs described in full, ticked rows only. */
  function buildEvents(legs, blocks) {
    const byKey = new Map(legs.map((l) => [l.key, l]));
    const legOf = (l) => (l.kind === "stock" ? { kind: "stock" } : { kind: l.kind, strike: l.strike, expiry: l.expiry });
    return blocks.map((b) => ({
      event: b.event,
      executed_at: b.date,
      fills: b.fills.filter((r) => r.include && byKey.has(r.key)).map((r) => ({
        leg: legOf(byKey.get(r.key)), qty: signed(r), price: r.price, commission: r.commission ?? 0,
      })),
    })).filter((e) => e.fills.length);
  }

  /** Realised $ before commissions, average cost per leg (as the server's ledger). Null if any price is missing. */
  function realised(legs, blocks) {
    if (legs.some((l) => !isNum(l.price))) return null;
    const rows = chronological(blocks).flatMap((i) => blocks[i].fills.filter(counts));
    if (rows.some((r) => !isNum(r.price))) return null;
    const books = new Map(legs.map((l) => [l.key, { q: l.qty, a: l.price, m: multiplier(l) }]));
    const total = rows.reduce((sum, r) => {
      const b = books.get(r.key);
      if (!b) return sum;
      const x = signed(r);
      const reducing = Math.abs(b.q) > EPS && (b.q > 0) !== (x > 0);
      const q = round(b.q + x);
      if (!reducing) {
        books.set(r.key, { ...b, q, a: (b.a * Math.abs(b.q) + r.price * Math.abs(x)) / Math.abs(q) });
        return sum;
      }
      const closed = Math.min(Math.abs(x), Math.abs(b.q));
      const flipped = Math.abs(q) > EPS && (q > 0) !== (b.q > 0);
      books.set(r.key, { ...b, q, a: flipped ? r.price : b.a });
      return sum + closed * (r.price - b.a) * (b.q > 0 ? 1 : -1) * b.m;
    }, 0);
    return Math.round(total * 100) / 100;
  }

  return { legKey, openingLegs, chronological, walk, newBlockRows, refit, ladder, validate, buildEvents, realised };
});
