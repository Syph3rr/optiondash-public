/* Journal editor (setup, plan, review, tags, confidence) shared by the form and trade page. */
(function (root) {
  "use strict";
  const { el, field, numVal, chipsInput, starInput } = UI;

  const DEFAULT_SUGGESTIONS = {
    emotion: ["fomo", "fear", "greed", "calm", "confident", "revenge", "bored", "impatient"],
    mistake: ["oversized", "early-exit", "late-exit", "no-plan", "chased-entry", "ignored-stop", "earnings-risk", "poor-liquidity"],
    tag: ["earnings", "high-iv", "0dte", "hedge", "income", "directional"],
  };

  const NUMBERS = [
    ["underlying_entry", "Underlying price at entry", "550.25"],
    ["iv_entry", "IV % at entry", "18.5"],
    ["iv_rank_entry", "IV rank (0-100)", "35"],
    ["max_risk_override", "Max risk $ (override)", "auto"],
  ];
  const PLAN = [["setup", "Setup / reason for entry"], ["thesis", "Thesis"], ["planned_exit", "Planned exit"]];
  const SHORT = [["profit_target", "Profit target", "50% of max"], ["stop_loss", "Stop loss", "2x credit"]];
  const REVIEW = [["review_right", "What went right"], ["review_wrong", "What went wrong"], ["lessons", "Lessons"], ["notes", "Notes"]];

  function suggestions(meta, kind) {
    return [...new Set([...(DEFAULT_SUGGESTIONS[kind] || []), ...((meta && meta.tags && meta.tags[kind]) || [])])];
  }

  /**
   * trade: existing values (or {}), meta: GET /api/meta, opts.review: show review fields.
   * Returns {el, read() -> payload fields, onChange(fn)}.
   */
  function journalForm(trade = {}, meta = null, { review = true } = {}) {
    const inputs = {};
    const listeners = [];
    const fire = () => listeners.forEach((fn) => fn());
    const text = (key, rows) => {
      const node = el("textarea", { rows, maxlength: 10000 });
      node.value = trade[key] ?? "";
      node.addEventListener("input", fire);
      inputs[key] = node;
      return node;
    };
    const line = (key, placeholder, type = "text") => {
      const node = el("input", { type, placeholder, step: type === "number" ? "any" : undefined, maxlength: type === "text" ? 200 : undefined });
      node.value = trade[key] ?? "";
      node.addEventListener("input", fire);
      inputs[key] = node;
      return node;
    };

    const tagsOf = (kind) => (trade.tags || []).filter((t) => t.kind === kind).map((t) => t.value);
    const chips = {
      emotion: chipsInput({ values: tagsOf("emotion"), suggestions: suggestions(meta, "emotion"), kind: "emotion" }),
      mistake: chipsInput({ values: tagsOf("mistake"), suggestions: suggestions(meta, "mistake"), kind: "mistake" }),
      tag: chipsInput({ values: tagsOf("tag"), suggestions: suggestions(meta, "tag") }),
    };
    Object.values(chips).forEach((c) => c.onChange(fire));
    const stars = starInput(trade.confidence ?? null);
    stars.onChange(fire);

    const node = el("div", { style: { display: "grid", gap: "14px" } },
      el("div", { class: "grid4" }, NUMBERS.map(([k, label, ph]) => field(label, line(k, ph, "number")))),
      el("div", { class: "grid2" },
        el("div", { style: { display: "grid", gap: "10px" } }, PLAN.map(([k, label]) => field(label, text(k, 3)))),
        el("div", { style: { display: "grid", gap: "10px", alignContent: "start" } },
          el("div", { class: "grid2" }, SHORT.map(([k, label, ph]) => field(label, line(k, ph)))),
          field("Confidence", stars.el),
          field("Emotions", chips.emotion.el),
          field("Mistakes", chips.mistake.el),
          field("Tags", chips.tag.el))),
      review ? el("div", { class: "grid2" }, REVIEW.map(([k, label]) => field(label, text(k, 3)))) : null);

    function read() {
      const out = {};
      for (const [k, label] of NUMBERS) {
        inputs[k].classList.remove("bad");
        const v = numVal(inputs[k]);
        if (Number.isNaN(v)) { inputs[k].classList.add("bad"); throw new Error(`${label} must be a number.`); }
        out[k] = v;
      }
      if (out.iv_rank_entry !== null && (out.iv_rank_entry < 0 || out.iv_rank_entry > 100)) throw new Error("IV rank must be between 0 and 100.");
      if (out.max_risk_override !== null && out.max_risk_override <= 0) throw new Error("Max risk override must be above 0, or left blank.");
      if (out.underlying_entry !== null && out.underlying_entry <= 0) throw new Error("Underlying price must be above 0.");
      if (out.iv_entry !== null && out.iv_entry < 0) throw new Error("IV must be 0 or more.");
      for (const [k] of [...PLAN, ...SHORT, ...(review ? REVIEW : [])]) {
        const v = inputs[k].value.trim();
        out[k] = v === "" ? null : v;
      }
      out.confidence = stars.value();
      out.tags = Object.entries(chips).flatMap(([kind, c]) => c.values().map((value) => ({ kind, value })));
      return out;
    }

    return { el: node, read, onChange: (fn) => listeners.push(fn), input: (k) => inputs[k] };
  }

  root.Journal = { journalForm, DEFAULT_SUGGESTIONS };
})(window);
