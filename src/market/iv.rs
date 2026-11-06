//! Input validation helpers and IV enrichment for market data rows.

use serde_json::{Map, Value, json};

use engine::{self, IvRequest, Kind, Model};

/// Inputs of the IV solve that come from the request, not from the sidecar.
#[derive(Debug, Clone, Copy)]
pub struct IvContext {
    /// Spot to solve with; `None` when neither the request nor the sidecar had one.
    pub spot: Option<f64>,
    pub rate: f64,
    pub div_yield: f64,
    pub model: Model,
}

const MAX_SYMBOL_LEN: usize = 10;
const EXPIRY_LEN: usize = 8;
const MIN_EXPIRY_YEAR: u32 = 2000;

/// `^[A-Z0-9.\-]{1,10}$`, the same rule the sidecar applies.
pub fn valid_symbol(s: &str) -> bool {
    (1..=MAX_SYMBOL_LEN).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        _ => 28,
    }
}

/// `YYYYMMDD` naming a real calendar date.
pub fn valid_expiry(s: &str) -> bool {
    if s.len() != EXPIRY_LEN || !s.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (s[..4].parse(), s[4..6].parse(), s[6..].parse()) else {
        return false;
    };
    year >= MIN_EXPIRY_YEAR
        && (1..=12).contains(&month)
        && (1..=days_in_month(year, month)).contains(&day)
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

pub(super) fn positive(v: Option<&Value>) -> Option<f64> {
    finite(v).filter(|x| *x > 0.0)
}

fn kind_of(right: Option<&Value>) -> Option<Kind> {
    match right.and_then(Value::as_str) {
        Some("C") => Some(Kind::Call),
        Some("P") => Some(Kind::Put),
        _ => None,
    }
}

fn solve(
    row: &Map<String, Value>,
    kind: Kind,
    mark: f64,
    dte: f64,
    ctx: &IvContext,
) -> Option<f64> {
    let req = IvRequest {
        kind,
        strike: positive(row.get("strike"))?,
        dte,
        premium: mark,
        spot: ctx.spot.filter(|s| s.is_finite() && *s > 0.0)?,
        rate: ctx.rate,
        div_yield: ctx.div_yield,
        model: ctx.model,
    };
    engine::solve_iv(&req)
        .ok()
        .filter(|iv| iv.is_finite() && *iv > 0.0)
}

/// Returns `raw` with `iv` and `iv_source` set and `ibkr_iv` removed. Any `iv` already in
/// `raw` (for example a Yahoo value) is discarded: the output IV is solved or IBKR's.
pub fn with_iv(raw: Value, ctx: &IvContext) -> Value {
    let Value::Object(mut row) = raw else {
        return raw;
    };
    row.remove("iv");
    let ibkr_iv = positive(row.get("ibkr_iv"));
    row.remove("ibkr_iv");

    let kind = kind_of(row.get("right"));
    let mark = finite(row.get("mark"));
    let dte = finite(row.get("dte")).filter(|d| *d > 0.0);
    let (iv, source) = match (kind, dte) {
        (Some(kind), Some(dte)) => match mark.and_then(|m| solve(&row, kind, m, dte, ctx)) {
            Some(iv) => (Some(iv), Some("solved")),
            None => (ibkr_iv, ibkr_iv.map(|_| "ibkr")),
        },
        _ => (None, None),
    };
    row.insert("iv".into(), json!(iv));
    row.insert("iv_source".into(), json!(source));
    Value::Object(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::{Kind, Mkt, unit_price};
    use serde_json::json;

    const RATE: f64 = 0.04;
    const DTE: f64 = 90.0;

    fn ctx(model: Model) -> IvContext {
        IvContext {
            spot: Some(100.0),
            rate: RATE,
            div_yield: 0.01,
            model,
        }
    }

    fn price(kind: Kind, strike: f64, iv: f64, model: Model) -> f64 {
        unit_price(
            kind,
            100.0,
            strike,
            DTE,
            iv,
            Mkt {
                rate: RATE,
                q: 0.01,
                model,
            },
        )
    }

    fn row(right: &str, strike: f64, mark: Value) -> Value {
        json!({ "right": right, "strike": strike, "dte": DTE, "mark": mark,
                "ibkr_iv": null, "bid": 1.0 })
    }

    fn close(v: &Value, want: f64) {
        let got = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
        assert!((got - want).abs() < 1e-4, "got {got}, want {want}");
    }

    #[test]
    fn iv_is_solved_from_mark_with_the_requested_model() {
        for (right, kind) in [("C", Kind::Call), ("P", Kind::Put)] {
            let mark = price(kind, 100.0, 0.20, Model::European);
            let out = with_iv(row(right, 100.0, json!(mark)), &ctx(Model::European));
            close(&out["iv"], 0.20);
            assert_eq!(out["iv_source"], "solved");
            assert_eq!(out["bid"], 1.0, "other fields pass through");
            assert!(out.get("ibkr_iv").is_none(), "ibkr_iv must be removed");
        }
    }

    #[test]
    fn model_change_changes_solved_iv() {
        // A deep ITM American put carries an early exercise premium.
        let mark = price(Kind::Put, 110.0, 0.20, Model::European);
        let euro = with_iv(row("P", 110.0, json!(mark)), &ctx(Model::European));
        let amer = with_iv(row("P", 110.0, json!(mark)), &ctx(Model::American));
        close(&euro["iv"], 0.20);
        let (e, a) = (euro["iv"].as_f64().unwrap(), amer["iv"].as_f64().unwrap());
        assert!((e - a).abs() > 1e-3, "european {e} vs american {a}");
        assert_eq!(amer["iv_source"], "solved");
    }

    #[test]
    fn solve_uses_the_context_spot() {
        let mark = price(Kind::Call, 100.0, 0.20, Model::European);
        let off = IvContext {
            spot: Some(120.0),
            ..ctx(Model::European)
        };
        let out = with_iv(row("C", 100.0, json!(mark)), &off);
        // Spot 120 makes the call far more valuable, so the same mark implies a
        // different vol (or cannot be solved at all).
        let iv = out["iv"].as_f64();
        assert!(iv.is_none_or(|v| (v - 0.20).abs() > 0.01), "{out}");
    }

    #[test]
    fn unsolvable_mark_uses_ibkr_iv() {
        // Mark 1.0 on a call 30 points in the money is below intrinsic.
        let mut r = row("C", 70.0, json!(1.0));
        r["ibkr_iv"] = json!(0.18);
        let out = with_iv(r, &ctx(Model::European));
        assert_eq!(out["iv"], 0.18);
        assert_eq!(out["iv_source"], "ibkr");
        assert!(out.get("ibkr_iv").is_none());
    }

    #[test]
    fn unsolvable_mark_without_ibkr_iv_gives_null() {
        let out = with_iv(row("C", 70.0, json!(1.0)), &ctx(Model::European));
        assert_eq!(out["iv"], Value::Null);
        assert_eq!(out["iv_source"], Value::Null);
    }

    #[test]
    fn unusable_ibkr_iv_is_not_surfaced() {
        for bad in [json!(0.0), json!(-0.2), json!("0.2")] {
            let mut r = row("C", 70.0, json!(1.0));
            r["ibkr_iv"] = bad;
            let out = with_iv(r, &ctx(Model::European));
            assert_eq!(out["iv"], Value::Null);
            assert_eq!(out["iv_source"], Value::Null);
        }
    }

    #[test]
    fn expired_leg_gives_null_iv_without_panicking() {
        for dte in [0.0, -1.0] {
            let mut r = row("C", 100.0, json!(2.0));
            r["dte"] = json!(dte);
            r["ibkr_iv"] = json!(0.3);
            let out = with_iv(r, &ctx(Model::European));
            assert_eq!(out["iv"], Value::Null);
            assert_eq!(out["iv_source"], Value::Null);
        }
    }

    #[test]
    fn null_mark_without_ibkr_iv_gives_null_iv() {
        let out = with_iv(row("C", 100.0, Value::Null), &ctx(Model::European));
        assert_eq!(out["iv"], Value::Null);
        assert_eq!(out["iv_source"], Value::Null);
    }

    #[test]
    fn null_mark_uses_ibkr_iv() {
        let mut r = row("C", 100.0, Value::Null);
        r["ibkr_iv"] = json!(0.3);
        let out = with_iv(r, &ctx(Model::European));
        assert_eq!(out["iv"], 0.3);
        assert_eq!(out["iv_source"], "ibkr");
    }

    #[test]
    fn stale_yahoo_iv_field_is_ignored() {
        let mark = price(Kind::Call, 100.0, 0.20, Model::European);
        let mut r = row("C", 100.0, json!(mark));
        r["iv"] = json!(0.00001);
        r["source"] = json!("yahoo");
        let solved = with_iv(r, &ctx(Model::European));
        close(&solved["iv"], 0.20);
        // And when nothing can be solved, the raw value must not leak either.
        let mut r = row("C", 70.0, json!(1.0));
        r["iv"] = json!(0.00001);
        r["source"] = json!("yahoo");
        let out = with_iv(r, &ctx(Model::European));
        assert_eq!(out["iv"], Value::Null);
        assert_eq!(out["iv_source"], Value::Null);
    }

    #[test]
    fn unknown_right_gives_null_iv() {
        for right in [json!("X"), json!("c"), Value::Null, json!(1)] {
            let mut r = row("C", 100.0, json!(5.0));
            r["right"] = right;
            r["ibkr_iv"] = json!(0.3);
            let out = with_iv(r, &ctx(Model::European));
            assert_eq!(out["iv"], Value::Null);
            assert_eq!(out["iv_source"], Value::Null);
        }
    }

    #[test]
    fn missing_spot_falls_back_to_ibkr_iv() {
        let none = IvContext {
            spot: None,
            ..ctx(Model::European)
        };
        let mut r = row("C", 100.0, json!(5.0));
        r["ibkr_iv"] = json!(0.25);
        let out = with_iv(r, &none);
        assert_eq!(out["iv"], 0.25);
        assert_eq!(out["iv_source"], "ibkr");
    }

    #[test]
    fn non_object_rows_pass_through() {
        assert_eq!(with_iv(json!(5), &ctx(Model::European)), json!(5));
    }

    #[test]
    fn rejects_bad_symbols() {
        for s in [
            "",
            "spx",
            "A B",
            "ABCDEFGHIJK",
            "../x",
            "SPX\n",
            "SPX/",
            "\u{e9}",
        ] {
            assert!(!valid_symbol(s), "{s:?}");
        }
        for s in ["SPX", "BRK.B", "ES-1", "A", "ABCDEFGHIJ", "0050"] {
            assert!(valid_symbol(s), "{s:?}");
        }
    }

    #[test]
    fn rejects_bad_expiries() {
        for s in [
            "2026-11-12",
            "2026111",
            "abcdefgh",
            "",
            "202611120",
            "20261301",
            "20261100",
            "20260230",
            "20250229",
            "\u{ff12}\u{ff10}\u{ff12}\u{ff16}\u{ff11}\u{ff11}\u{ff11}\u{ff12}",
        ] {
            assert!(!valid_expiry(s), "{s:?}");
        }
        for s in ["20261112", "20240229", "20261231"] {
            assert!(valid_expiry(s), "{s:?}");
        }
    }
}
