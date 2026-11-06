//! Strategy engine: prices every leg over a (date × underlying price) grid with
//! OptionStratLib and aggregates P&L and position Greeks.

use optionstratlib::greeks::{delta_b76, gamma_b76, rho_b76, theta_b76, vega_b76};
use optionstratlib::prelude::*;
use optionstratlib::pricing::{black_76, black_scholes};
use rayon::prelude::*;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use serde::{Deserialize, Serialize};

const MIN_IV: f64 = 0.005;
const EXPIRED: f64 = 1e-7; // days
/// Room for the Greeks animation's 40 frames in one request, while still bounding the grid.
const MAX_AT_DAYS: usize = 64;

// ---------------------------------------------------------------- inputs

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    /// Black-Scholes-Merton, European exercise (index options such as SPX/XSP, ASX XJO)
    European,
    /// Black-76 on a futures/forward price (ES, NQ, CL, GC futures options)
    Futures,
    /// Barone-Adesi-Whaley approximation, American exercise (single stocks, ETFs)
    American,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Call,
    Put,
    Stock,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Leg {
    pub kind: Kind,
    /// +1 long / -1 short
    pub long: bool,
    pub qty: f64,
    #[serde(default)]
    pub strike: f64,
    /// days to expiry from "now" (fractional allowed, e.g. 0.25 = 6 hours)
    #[serde(default)]
    pub dte: f64,
    /// annualised implied vol as a decimal (0.20 = 20%)
    #[serde(default)]
    pub iv: f64,
    /// price paid/received per unit; None → theoretical value now
    pub premium: Option<f64>,
    /// contract multiplier (100 for US equity/index options, 50 for ES, 1 for shares)
    pub multiplier: f64,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn yes() -> bool {
    true
}

#[derive(Deserialize, Debug)]
pub struct AnalyseRequest {
    pub spot: f64,
    pub rate: f64,
    #[serde(default)]
    pub div_yield: f64,
    pub model: Model,
    pub legs: Vec<Leg>,
    /// parallel shift added to every leg's IV (decimal: 0.05 = +5 vol pts)
    #[serde(default)]
    pub iv_shift: f64,
    /// half-width of the price axis as a fraction of spot (0.15 = ±15%)
    #[serde(default = "default_range")]
    pub range: f64,
    #[serde(default = "default_np")]
    pub n_prices: usize,
    #[serde(default = "default_nd")]
    pub n_dates: usize,
    /// extra times (days from now) to price exactly, on top of the even grid
    #[serde(default)]
    pub at_days: Vec<f64>,
}
fn default_range() -> f64 {
    0.15
}
fn default_np() -> usize {
    121
}
fn default_nd() -> usize {
    40
}

#[derive(Deserialize)]
pub struct IvRequest {
    pub kind: Kind,
    pub strike: f64,
    pub dte: f64,
    pub premium: f64,
    pub spot: f64,
    pub rate: f64,
    #[serde(default)]
    pub div_yield: f64,
    pub model: Model,
}

// ---------------------------------------------------------------- outputs

#[derive(Serialize, Default, Clone, Copy)]
pub struct G {
    pub delta: f64,
    pub gamma: f64,
    pub theta: f64,
    pub vega: f64,
    pub rho: f64,
}
impl std::ops::AddAssign for G {
    fn add_assign(&mut self, o: G) {
        self.delta += o.delta;
        self.gamma += o.gamma;
        self.theta += o.theta;
        self.vega += o.vega;
        self.rho += o.rho;
    }
}

/// Second-order Greeks (European / Black-Scholes only).
#[derive(Serialize, Default, Clone, Copy)]
pub struct G2 {
    pub vanna: f64,
    pub vomma: f64,
    pub veta: f64,
    pub charm: f64,
    pub color: f64,
}

#[derive(Serialize)]
pub struct LegInfo {
    pub theo: f64,
    pub entry: f64,
    /// signed cash flow at entry: negative = debit
    pub cash: f64,
    pub greeks: G,
}

#[derive(Serialize)]
pub struct Matrices {
    pub pnl: Vec<Vec<f64>>,
    pub delta: Vec<Vec<f64>>,
    pub gamma: Vec<Vec<f64>>,
    pub theta: Vec<Vec<f64>>,
    pub vega: Vec<Vec<f64>>,
    pub rho: Vec<Vec<f64>>,
}

#[derive(Serialize)]
pub struct Summary {
    pub net_cash: f64,
    pub max_profit: Option<f64>, // None = unlimited
    pub max_loss: Option<f64>,   // None = unlimited (reported as a negative number)
    pub breakevens: Vec<f64>,
    pub pop: Option<f64>,
    pub first_expiry: f64,
    pub expected_move: Option<f64>,
    pub now: G,
    pub now2: Option<G2>,
}

#[derive(Serialize)]
pub struct AnalyseResponse {
    pub prices: Vec<f64>,
    pub times: Vec<f64>,
    pub spot_index: usize,
    pub expiries: Vec<f64>,
    pub grid: Matrices,
    pub expiry_curve: Vec<f64>,
    pub legs: Vec<Option<LegInfo>>,
    pub summary: Summary,
}

// ---------------------------------------------------------------- helpers

fn d(x: f64) -> Decimal {
    Decimal::from_f64(x).unwrap_or(Decimal::ZERO)
}
fn f(x: Decimal) -> f64 {
    x.to_f64().unwrap_or(f64::NAN)
}
fn pos(x: f64) -> Positive {
    Positive::new(x.max(0.0)).unwrap_or(Positive::ZERO)
}

#[derive(Clone, Copy)]
pub struct Mkt {
    pub rate: f64,
    pub q: f64,
    pub model: Model,
}

fn intrinsic(kind: Kind, s: f64, k: f64) -> f64 {
    match kind {
        Kind::Call => (s - k).max(0.0),
        Kind::Put => (k - s).max(0.0),
        Kind::Stock => s,
    }
}

fn build(kind: Kind, long: bool, size: f64, s: f64, k: f64, days: f64, iv: f64, m: Mkt) -> Options {
    let mut o = Options::new(
        OptionType::European,
        if long { Side::Long } else { Side::Short },
        "UND".to_string(),
        pos(k),
        ExpirationDate::Days(pos(days)),
        pos(iv.max(MIN_IV)),
        Positive::ONE,
        pos(s.max(1e-6)),
        d(m.rate),
        if kind == Kind::Put { OptionStyle::Put } else { OptionStyle::Call },
        pos(if m.model == Model::Futures { 0.0 } else { m.q }),
        None,
    );
    o.contract_size = pos(size); // Greeks come back scaled by quantity × contract_size
    o
}

/// Value of ONE long unit (not multiplied).
pub fn unit_price(kind: Kind, s: f64, k: f64, days: f64, iv: f64, m: Mkt) -> f64 {
    if kind == Kind::Stock {
        return s;
    }
    if days <= EXPIRED {
        return intrinsic(kind, s, k);
    }
    let r = match m.model {
        Model::European => black_scholes(&build(kind, true, 1.0, s, k, days, iv, m)).map(f).ok(),
        Model::Futures => black_76(&build(kind, true, 1.0, s, k, days, iv, m)).map(f).ok(),
        // f64 port of OptionStratLib's Barone-Adesi-Whaley (see `baw`), checked against the
        // library in tests. The library's Decimal version is ~100× slower — too slow for a grid.
        Model::American => Some(baw(kind, s, k, days / 365.0, m.rate, m.q, iv.max(MIN_IV))),
    };
    // Numerical edge cases (deep ITM/OTM) fall back to intrinsic
    let iv_ = intrinsic(kind, s, k);
    let v = r.filter(|v| v.is_finite()).unwrap_or(iv_);
    if m.model == Model::American { v.max(iv_) } else { v.max(0.0) }
}

/// Position Greeks for one leg: signed by side, scaled by qty × multiplier.
/// Units: delta (underlying units), gamma (delta per 1.00 move), theta ($/calendar day),
/// vega ($ per 1 vol point), rho ($ per 1% rate move).
fn leg_greeks(leg: &Leg, s: f64, days: f64, iv: f64, m: Mkt) -> G {
    let size = leg.qty * leg.multiplier;
    let sign = if leg.long { 1.0 } else { -1.0 };
    if leg.kind == Kind::Stock {
        return G { delta: sign * size, ..G::default() };
    }
    if days <= EXPIRED {
        let itm = intrinsic(leg.kind, s, leg.strike) > 0.0;
        let dl = match (leg.kind, itm) {
            (Kind::Call, true) => 1.0,
            (Kind::Put, true) => -1.0,
            _ => 0.0,
        };
        return G { delta: sign * size * dl, ..G::default() };
    }
    let o = build(leg.kind, leg.long, size, s, leg.strike, days, iv, m);
    let analytic = match m.model {
        Model::European => o.greeks().ok().map(|g| G {
            delta: f(g.delta),
            gamma: f(g.gamma),
            theta: f(g.theta),
            vega: f(g.vega),
            rho: f(g.rho),
        }),
        Model::Futures => (|| {
            Some(G {
                delta: f(delta_b76(&o).ok()?),
                gamma: f(gamma_b76(&o).ok()?),
                theta: f(theta_b76(&o).ok()?),
                vega: f(vega_b76(&o).ok()?),
                rho: f(rho_b76(&o).ok()?),
            })
        })(),
        Model::American => None,
    };
    match analytic {
        Some(g) if [g.delta, g.gamma, g.theta, g.vega, g.rho].iter().all(|x| x.is_finite()) => g,
        _ => fd_greeks(leg, s, days, iv, m, sign * size),
    }
}

/// Finite-difference Greeks on the model price (American, and a fallback for edge cases).
fn fd_greeks(leg: &Leg, s: f64, days: f64, iv: f64, m: Mkt, scale: f64) -> G {
    let p = |s: f64, days: f64, iv: f64, m: Mkt| unit_price(leg.kind, s, leg.strike, days, iv, m);
    let h = (s * 1e-3).max(1e-4);
    let p0 = p(s, days, iv, m);
    let up = p(s + h, days, iv, m);
    let dn = p(s - h, days, iv, m);
    let dt = days.min(1.0);
    let mut r_up = m;
    r_up.rate += 0.01;
    let mut r_dn = m;
    r_dn.rate -= 0.01;
    G {
        delta: scale * (up - dn) / (2.0 * h),
        gamma: scale * (up - 2.0 * p0 + dn) / (h * h),
        theta: scale * (p(s, days - dt, iv, m) - p0) / dt,
        vega: scale * (p(s, days, iv + 0.01, m) - p(s, days, (iv - 0.01).max(MIN_IV), m))
            / (iv + 0.01 - (iv - 0.01).max(MIN_IV))
            * 0.01,
        rho: scale * (p(s, days, iv, r_up) - p(s, days, iv, r_dn)) / 2.0,
    }
}

fn leg_iv(leg: &Leg, shift: f64) -> f64 {
    (leg.iv + shift).max(MIN_IV)
}

fn norm_cdf(x: f64) -> f64 {
    0.5 * libm::erfc(-x / std::f64::consts::SQRT_2)
}
fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

/// Generalised Black-Scholes with cost of carry b = r − q.
fn gbs(call: bool, s: f64, k: f64, t: f64, r: f64, b: f64, v: f64) -> f64 {
    let d1 = ((s / k).ln() + (b + 0.5 * v * v) * t) / (v * t.sqrt());
    let d2 = d1 - v * t.sqrt();
    if call {
        s * ((b - r) * t).exp() * norm_cdf(d1) - k * (-r * t).exp() * norm_cdf(d2)
    } else {
        k * (-r * t).exp() * norm_cdf(-d2) - s * ((b - r) * t).exp() * norm_cdf(-d1)
    }
}

/// Barone-Adesi-Whaley (1987) American approximation (Haug's formulation), in f64.
fn baw(kind: Kind, s: f64, x: f64, t: f64, r: f64, q: f64, v: f64) -> f64 {
    let call = kind == Kind::Call;
    let b = r - q;
    let euro = gbs(call, s, x, t, r, b, v);
    // No early-exercise premium: calls without dividends, or non-positive rates (puts)
    if (call && b >= r) || r <= 1e-9 || t <= 0.0 {
        return euro;
    }
    let vst = v * t.sqrt();
    let n = 2.0 * b / (v * v);
    let m = 2.0 * r / (v * v);
    let kk = 1.0 - (-r * t).exp();
    let carry = ((b - r) * t).exp();
    let d1 = |si: f64| ((si / x).ln() + (b + 0.5 * v * v) * t) / vst;
    if call {
        let q2u = (-(n - 1.0) + ((n - 1.0).powi(2) + 4.0 * m).sqrt()) / 2.0;
        let su = x / (1.0 - 1.0 / q2u);
        let h2 = -(b * t + 2.0 * vst) * x / (su - x);
        let mut si = x + (su - x) * (1.0 - h2.exp());
        let q2 = (-(n - 1.0) + ((n - 1.0).powi(2) + 4.0 * m / kk).sqrt()) / 2.0;
        for _ in 0..200 {
            let dd = d1(si);
            let rhs = gbs(true, si, x, t, r, b, v) + (1.0 - carry * norm_cdf(dd)) * si / q2;
            if ((si - x - rhs) / x).abs() < 1e-10 {
                break;
            }
            let bi = carry * norm_cdf(dd) * (1.0 - 1.0 / q2) + (1.0 - carry * norm_pdf(dd) / vst) / q2;
            si = (x + rhs - bi * si) / (1.0 - bi);
        }
        if s < si {
            let a2 = (si / q2) * (1.0 - carry * norm_cdf(d1(si)));
            euro + a2 * (s / si).powf(q2)
        } else {
            s - x
        }
    } else {
        let q1u = (-(n - 1.0) - ((n - 1.0).powi(2) + 4.0 * m).sqrt()) / 2.0;
        let su = x / (1.0 - 1.0 / q1u);
        let h1 = (b * t - 2.0 * vst) * x / (x - su);
        let mut si = su + (x - su) * h1.exp();
        let q1 = (-(n - 1.0) - ((n - 1.0).powi(2) + 4.0 * m / kk).sqrt()) / 2.0;
        for _ in 0..200 {
            let dd = d1(si);
            let rhs = gbs(false, si, x, t, r, b, v) - (1.0 - carry * norm_cdf(-dd)) * si / q1;
            if ((x - si - rhs) / x).abs() < 1e-10 {
                break;
            }
            let bi = -carry * norm_cdf(-dd) * (1.0 - 1.0 / q1) - (1.0 + carry * norm_pdf(-dd) / vst) / q1;
            si = (x - rhs + bi * si) / (1.0 + bi);
        }
        if s > si {
            let a1 = -(si / q1) * (1.0 - carry * norm_cdf(-d1(si)));
            euro + a1 * (s / si).powf(q1)
        } else {
            x - s
        }
    }
}

// ---------------------------------------------------------------- analyse

pub fn analyse(req: &AnalyseRequest) -> Result<AnalyseResponse, String> {
    if !(req.spot > 0.0) {
        return Err("Underlying price must be positive".into());
    }
    let m = Mkt { rate: req.rate, q: req.div_yield, model: req.model };
    let legs: Vec<&Leg> = req.legs.iter().filter(|l| l.enabled && l.qty > 0.0).collect();
    for l in &legs {
        if l.kind != Kind::Stock && (l.strike <= 0.0 || l.dte < 0.0) {
            return Err("Each option leg needs a positive strike and non-negative DTE".into());
        }
    }

    // --- price axis (odd count so spot is exactly the middle point)
    let n_p = (req.n_prices.clamp(21, 401) / 2) * 2 + 1;
    let range = req.range.clamp(0.005, 0.95);
    let lo = req.spot * (1.0 - range);
    let hi = req.spot * (1.0 + range);
    let prices: Vec<f64> = (0..n_p).map(|i| lo + (hi - lo) * i as f64 / (n_p - 1) as f64).collect();
    let spot_index = n_p / 2;

    // --- time axis: now → last expiry, plus every leg expiry exactly
    let mut expiries: Vec<f64> = legs.iter().filter(|l| l.kind != Kind::Stock).map(|l| l.dte).collect();
    expiries.sort_by(|a, b| a.partial_cmp(b).unwrap());
    expiries.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let t_max = expiries.last().copied().unwrap_or(0.0);
    let n_d = req.n_dates.clamp(2, 200);
    let mut times: Vec<f64> = if t_max > 0.0 {
        (0..n_d).map(|i| t_max * i as f64 / (n_d - 1) as f64).collect()
    } else {
        vec![0.0]
    };
    times.extend(expiries.iter().copied());
    times.extend(
        req.at_days.iter().copied().filter(|t| t.is_finite() && (0.0..=t_max).contains(t)).take(MAX_AT_DAYS),
    );
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    times.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

    // --- entry prices
    let entries: Vec<f64> = legs
        .iter()
        .map(|l| match (l.kind, l.premium) {
            (_, Some(p)) => p,
            (Kind::Stock, None) => req.spot,
            (_, None) => unit_price(l.kind, req.spot, l.strike, l.dte, leg_iv(l, 0.0), m),
        })
        .collect();

    let pnl_at = |s: f64, t: f64| -> f64 {
        legs.iter()
            .zip(&entries)
            .map(|(l, e)| {
                let sign = if l.long { 1.0 } else { -1.0 };
                let v = unit_price(l.kind, s, l.strike, l.dte - t, leg_iv(l, req.iv_shift), m);
                sign * l.qty * l.multiplier * (v - e)
            })
            .sum()
    };
    let greeks_at = |s: f64, t: f64| -> G {
        let mut g = G::default();
        for l in &legs {
            g += leg_greeks(l, s, l.dte - t, leg_iv(l, req.iv_shift), m);
        }
        g
    };

    // --- the grid (parallel over dates)
    let rows: Vec<(Vec<f64>, Vec<G>)> = times
        .par_iter()
        .map(|&t| {
            let p: Vec<f64> = prices.iter().map(|&s| pnl_at(s, t)).collect();
            let g: Vec<G> = prices.iter().map(|&s| greeks_at(s, t)).collect();
            (p, g)
        })
        .collect();
    let pick = |sel: fn(&G) -> f64| -> Vec<Vec<f64>> {
        rows.iter().map(|(_, g)| g.iter().map(sel).collect()).collect()
    };
    let grid = Matrices {
        pnl: rows.iter().map(|(p, _)| p.clone()).collect(),
        delta: pick(|g| g.delta),
        gamma: pick(|g| g.gamma),
        theta: pick(|g| g.theta),
        vega: pick(|g| g.vega),
        rho: pick(|g| g.rho),
    };

    // --- reference curve: P&L at the FIRST expiry (what OptionStrat draws for calendars too)
    let first_exp = expiries.first().copied().unwrap_or(0.0);
    let expiry_curve: Vec<f64> = prices.iter().map(|&s| pnl_at(s, first_exp)).collect();

    // --- summary on a wide, fine grid at first expiry
    let wide_lo = req.spot * 0.01;
    let wide_hi = req.spot * 4.0;
    let nw = 1600;
    let ws: Vec<f64> = (0..=nw).map(|i| wide_lo + (wide_hi - wide_lo) * i as f64 / nw as f64).collect();
    let wv: Vec<f64> = ws.par_iter().map(|&s| pnl_at(s, first_exp)).collect();
    let tail_slope = (wv[nw] - wv[nw - 1]) / (ws[nw] - ws[nw - 1]);
    // "Unlimited" only when the far-right slope is material — at least a quarter of the
    // smallest leg's size per point (a naked short call has slope = −qty×mult). Calendars
    // with a dividend yield have a tiny residual slope that shouldn't read as unlimited.
    let flat = 0.25 * legs.iter().map(|l| l.qty * l.multiplier).fold(f64::MAX, f64::min).min(1e12);
    let max_v = wv.iter().cloned().fold(f64::MIN, f64::max);
    let min_v = wv.iter().cloned().fold(f64::MAX, f64::min);
    let max_profit = if tail_slope > flat { None } else { Some(max_v) };
    let max_loss = if tail_slope < -flat { None } else { Some(min_v) };
    let mut breakevens = vec![];
    // Sign changes, ignoring sub-cent noise (flat-at-zero regions are not breakevens)
    const CENT: f64 = 0.01;
    for i in 0..nw {
        let (a, b) = (wv[i], wv[i + 1]);
        if (a < -CENT && b > CENT) || (a > CENT && b < -CENT) || (a.abs() > CENT && b.abs() <= CENT && {
            // a crossing that lands on ~0: count it only if the curve then leaves zero the other way
            let nxt = wv[i + 1..].iter().find(|v| v.abs() > CENT);
            nxt.is_some_and(|v| v.signum() != a.signum())
        }) {
            breakevens.push(ws[i] + (ws[i + 1] - ws[i]) * a / (a - b));
        }
    }

    // probability of profit at first expiry: lognormal with mean IV of the legs
    let opt_legs: Vec<&&Leg> = legs.iter().filter(|l| l.kind != Kind::Stock).collect();
    let (pop, expected_move) = if opt_legs.is_empty() || first_exp <= EXPIRED {
        (None, None)
    } else {
        let sigma = opt_legs.iter().map(|l| leg_iv(l, req.iv_shift)).sum::<f64>() / opt_legs.len() as f64;
        let tt = first_exp / 365.0;
        let mu = if req.model == Model::Futures { 0.0 } else { req.rate - req.div_yield };
        let m0 = req.spot.ln() + (mu - 0.5 * sigma * sigma) * tt;
        let sd = sigma * tt.sqrt();
        let cdf = |s: f64| if s <= 0.0 { 0.0 } else { norm_cdf((s.ln() - m0) / sd) };
        let mut p = if wv[0] > 0.01 { cdf(ws[0]) } else { 0.0 };
        for i in 0..nw {
            if 0.5 * (wv[i] + wv[i + 1]) > 0.01 {
                p += cdf(ws[i + 1]) - cdf(ws[i]);
            }
        }
        if wv[nw] > 0.01 {
            p += 1.0 - cdf(ws[nw]);
        }
        (Some(p.clamp(0.0, 1.0)), Some(req.spot * sd))
    };

    // --- per-leg info and "now" greeks (incl. 2nd order for European)
    let mut infos: Vec<Option<LegInfo>> = Vec::with_capacity(req.legs.len());
    let mut li = 0;
    for l in &req.legs {
        if !(l.enabled && l.qty > 0.0) {
            infos.push(None);
            continue;
        }
        let entry = entries[li];
        li += 1;
        let theo = match l.kind {
            Kind::Stock => req.spot,
            _ => unit_price(l.kind, req.spot, l.strike, l.dte, leg_iv(l, req.iv_shift), m),
        };
        let sign = if l.long { 1.0 } else { -1.0 };
        infos.push(Some(LegInfo {
            theo,
            entry,
            cash: -sign * l.qty * l.multiplier * entry,
            greeks: leg_greeks(l, req.spot, l.dte, leg_iv(l, req.iv_shift), m),
        }));
    }
    let net_cash = infos.iter().flatten().map(|i| i.cash).sum();
    let now = greeks_at(req.spot, 0.0);
    let now2 = if req.model == Model::European {
        let mut g2 = G2::default();
        for l in legs.iter().filter(|l| l.kind != Kind::Stock && l.dte > EXPIRED) {
            let o = build(l.kind, l.long, l.qty * l.multiplier, req.spot, l.strike, l.dte, leg_iv(l, req.iv_shift), m);
            if let Ok(g) = o.greeks() {
                g2.vanna += f(g.vanna);
                g2.vomma += f(g.vomma);
                g2.veta += f(g.veta);
                g2.charm += f(g.charm);
                g2.color += f(g.color);
            }
        }
        Some(g2)
    } else {
        None
    };

    Ok(AnalyseResponse {
        prices,
        times,
        spot_index,
        expiries,
        grid,
        expiry_curve,
        legs: infos,
        summary: Summary {
            net_cash,
            max_profit,
            max_loss,
            breakevens,
            pop,
            first_expiry: first_exp,
            expected_move,
            now,
            now2,
        },
    })
}

/// Implied vol from a premium by bisection on the selected model's price.
pub fn solve_iv(r: &IvRequest) -> Result<f64, String> {
    if r.kind == Kind::Stock {
        return Err("Stock legs have no IV".into());
    }
    let m = Mkt { rate: r.rate, q: r.div_yield, model: r.model };
    let price = |iv: f64| unit_price(r.kind, r.spot, r.strike, r.dte, iv, m);
    let (mut lo, mut hi) = (MIN_IV, 5.0);
    if r.dte <= EXPIRED {
        return Err("Option is at expiry — no time value to imply a vol from".into());
    }
    if r.premium < price(lo) - 1e-9 {
        return Err("Premium is below the minimum model value (check intrinsic/strike)".into());
    }
    if r.premium > price(hi) {
        return Err("Premium implies vol above 500%".into());
    }
    for _ in 0..100 {
        let mid = 0.5 * (lo + hi);
        if price(mid) < r.premium { lo = mid } else { hi = mid }
    }
    Ok(0.5 * (lo + hi))
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn leg(kind: Kind, long: bool, k: f64, dte: f64) -> Leg {
        Leg { kind, long, qty: 1.0, strike: k, dte, iv: 0.2, premium: None, multiplier: 1.0, enabled: true }
    }
    const M: [Model; 3] = [Model::European, Model::Futures, Model::American];

    #[test]
    fn bs_reference_value() {
        // Hull: S=K=100, r=5%, σ=20%, T=1 → call 10.4506
        let m = Mkt { rate: 0.05, q: 0.0, model: Model::European };
        let c = unit_price(Kind::Call, 100.0, 100.0, 365.0, 0.2, m);
        assert!((c - 10.4506).abs() < 1e-3, "{c}");
    }

    #[test]
    fn analytic_greeks_match_finite_differences() {
        for model in [Model::European, Model::Futures] {
            let m = Mkt { rate: 0.04, q: 0.01, model };
            for kind in [Kind::Call, Kind::Put] {
                for long in [true, false] {
                    let mut l = leg(kind, long, 105.0, 45.0);
                    l.qty = 2.0;
                    l.multiplier = 100.0;
                    let a = leg_greeks(&l, 100.0, 45.0, 0.25, m);
                    let n = fd_greeks(&l, 100.0, 45.0, 0.25, m, if long { 200.0 } else { -200.0 });
                    let close = |x: f64, y: f64, name: &str| {
                        assert!((x - y).abs() <= 0.02 * y.abs().max(1e-2) + 1e-3,
                            "{model:?} {kind:?} long={long} {name}: analytic {x} vs fd {y}")
                    };
                    close(a.delta, n.delta, "delta");
                    close(a.gamma, n.gamma, "gamma");
                    close(a.theta, n.theta, "theta");
                    close(a.vega, n.vega, "vega");
                    close(a.rho, n.rho, "rho");
                }
            }
        }
    }

    #[test]
    fn put_call_parity_and_american_premium() {
        let m = Mkt { rate: 0.05, q: 0.0, model: Model::European };
        let c = unit_price(Kind::Call, 100.0, 95.0, 90.0, 0.3, m);
        let p = unit_price(Kind::Put, 100.0, 95.0, 90.0, 0.3, m);
        let t = 90.0 / 365.0;
        assert!((c - p - (100.0 - 95.0 * (-0.05f64 * t).exp())).abs() < 1e-3);
        let am = Mkt { model: Model::American, ..m };
        assert!(unit_price(Kind::Put, 100.0, 110.0, 90.0, 0.3, am) >= p.max(10.0) - 1e-6);
    }

    #[test]
    fn iron_condor_summary() {
        let mk = |k, kind, long| Leg { premium: None, ..leg(kind, long, k, 30.0) };
        let req = AnalyseRequest {
            spot: 100.0, rate: 0.04, div_yield: 0.0, model: Model::European,
            legs: vec![mk(90.0, Kind::Put, true), mk(95.0, Kind::Put, false), mk(105.0, Kind::Call, false), mk(110.0, Kind::Call, true)],
            iv_shift: 0.0, range: 0.2, n_prices: 121, n_dates: 30, at_days: vec![],
        };
        let r = analyse(&req).unwrap();
        let s = &r.summary;
        assert!(s.net_cash > 0.0, "condor is a credit");
        assert_eq!(s.breakevens.len(), 2);
        assert!((s.max_profit.unwrap() - s.net_cash).abs() < 1e-6);
        assert!((s.max_loss.unwrap() - (s.net_cash - 5.0)).abs() < 1e-3);
        let pop = s.pop.unwrap();
        assert!(pop > 0.3 && pop < 0.95, "{pop}");
        // P&L at t=0, spot is ~0 (entered at theo)
        assert!(r.grid.pnl[0][r.spot_index].abs() < 1e-9);
    }

    #[test]
    fn long_call_unlimited_and_iv_roundtrip() {
        for model in M {
            let req = AnalyseRequest {
                spot: 100.0, rate: 0.04, div_yield: 0.0, model,
                legs: vec![leg(Kind::Call, true, 100.0, 30.0)],
                iv_shift: 0.0, range: 0.15, n_prices: 61, n_dates: 10, at_days: vec![],
            };
            let r = analyse(&req).unwrap();
            assert!(r.summary.max_profit.is_none());
            let theo = r.legs[0].as_ref().unwrap().theo;
            let iv = solve_iv(&IvRequest { kind: Kind::Call, strike: 100.0, dte: 30.0, premium: theo, spot: 100.0, rate: 0.04, div_yield: 0.0, model }).unwrap();
            assert!((iv - 0.2).abs() < 1e-4, "{model:?} {iv}");
        }
    }

    fn thirty_day_call(at_days: Vec<f64>) -> AnalyseRequest {
        AnalyseRequest {
            spot: 100.0, rate: 0.04, div_yield: 0.0, model: Model::European,
            legs: vec![Leg { premium: None, ..leg(Kind::Call, true, 100.0, 30.0) }],
            iv_shift: 0.0, range: 0.15, n_prices: 61, n_dates: 40, at_days,
        }
    }

    #[test]
    fn requested_time_is_priced_exactly_between_grid_points() {
        // 3.4 days is not a multiple of the 30/39 day grid step
        let req = thirty_day_call(vec![3.4]);
        let r = analyse(&req).unwrap();
        let row = r.times.iter().position(|t| (t - 3.4).abs() < 1e-9).expect("3.4d in times");

        let l = &req.legs[0];
        let m = Mkt { rate: 0.04, q: 0.0, model: Model::European };
        let entry = unit_price(Kind::Call, 100.0, 100.0, 30.0, l.iv, m);
        let later = unit_price(Kind::Call, 100.0, 100.0, 26.6, l.iv, m);
        let want = l.qty * l.multiplier * (later - entry);
        assert!((r.grid.pnl[row][r.spot_index] - want).abs() < 1e-9);
    }

    #[test]
    fn requested_times_outside_the_trade_are_ignored() {
        let base = analyse(&thirty_day_call(vec![])).unwrap();
        let r = analyse(&thirty_day_call(vec![-1.0, 99.0, f64::NAN, f64::INFINITY])).unwrap();
        assert_eq!(r.times.len(), base.times.len());
        assert_eq!(r.times.last(), Some(&30.0));
    }

    #[test]
    fn requested_times_cannot_bypass_the_row_limit() {
        let base = analyse(&thirty_day_call(vec![])).unwrap();
        let many: Vec<f64> = (0..500).map(|i| 0.0137 + i as f64 * 0.0531).collect();
        let r = analyse(&thirty_day_call(many)).unwrap();
        assert!(
            r.times.len() <= base.times.len() + MAX_AT_DAYS,
            "{} rows",
            r.times.len()
        );
    }

    #[test]
    fn requested_times_are_capped_at_64_rows() {
        // 70 distinct times inside the trade, none on the 30/39-day grid: exactly 64 get through
        let base = analyse(&thirty_day_call(vec![])).unwrap();
        let many: Vec<f64> = (0..70).map(|i| 0.0137 + i as f64 * 0.4).collect();
        let r = analyse(&thirty_day_call(many)).unwrap();
        assert_eq!(r.times.len(), base.times.len() + 64);
    }

    #[test]
    fn forty_animation_frames_are_all_priced_in_one_request() {
        // The Greeks animation prices 40 frames between two dates in one call
        let frames: Vec<f64> = (0..40).map(|i| 0.37 + i as f64 * (29.0 / 39.0)).collect();
        let r = analyse(&thirty_day_call(frames.clone())).unwrap();
        for t in &frames {
            assert!(r.times.iter().any(|x| (x - t).abs() < 1e-9), "{t}d missing from times");
        }
    }

    #[test]
    fn zero_dte_hours() {
        let m = Mkt { rate: 0.04, q: 0.0, model: Model::European };
        let v = unit_price(Kind::Call, 5000.0, 5000.0, 0.25, 0.15, m);
        // ATM ≈ 0.4 σ S √T
        let approx = 0.4 * 0.15 * 5000.0 * (0.25f64 / 365.0).sqrt();
        assert!((v - approx).abs() / approx < 0.05, "{v} vs {approx}");
    }

    #[test]
    fn baw_port_matches_optionstratlib() {
        use optionstratlib::pricing::barone_adesi_whaley;
        let mut worst = 0.0f64;
        for (kind, style) in [(Kind::Put, OptionStyle::Put), (Kind::Call, OptionStyle::Call)] {
            for s in [70.0, 90.0, 100.0, 110.0, 140.0] {
                for (t, r, q, v) in [(0.25, 0.05, 0.0, 0.2), (1.0, 0.08, 0.04, 0.35), (0.05, 0.03, 0.02, 0.6), (0.5, 0.04, 0.06, 0.25)] {
                    let lib = f(barone_adesi_whaley(pos(s), pos(100.0), pos(t), d(r), pos(q), pos(v), &style).unwrap());
                    let mine = baw(kind, s, 100.0, t, r, q, v);
                    worst = worst.max((lib - mine).abs());
                    assert!((lib - mine).abs() < 1e-3 + 1e-4 * lib, "{kind:?} S={s} t={t} r={r} q={q} v={v}: lib {lib} vs f64 {mine}");
                }
            }
        }
        eprintln!("worst |BAW f64 - OptionStratLib| = {worst:e}");
        // Haug (2007) table: American put S=100 K=100 T=0.5 r=0.10 b=0 (q=r) σ=0.25 ≈ 7.0 range sanity
        assert!(baw(Kind::Put, 100.0, 100.0, 0.5, 0.1, 0.1, 0.25) > gbs(false, 100.0, 100.0, 0.5, 0.1, 0.0, 0.25));
    }

    #[test]
    fn calendar_loss_is_bounded_and_flat_zero_has_no_breakevens() {
        let mut back = leg(Kind::Call, true, 100.0, 60.0);
        back.iv = 0.19;
        let req = AnalyseRequest {
            spot: 100.0, rate: 0.04, div_yield: 0.013, model: Model::European,
            legs: vec![leg(Kind::Call, false, 100.0, 30.0), back],
            iv_shift: 0.0, range: 0.15, n_prices: 61, n_dates: 10, at_days: vec![],
        };
        let s = analyse(&req).unwrap().summary;
        assert!(s.max_loss.is_some() && s.max_profit.is_some());
        assert_eq!(s.breakevens.len(), 2);
        // 0DTE far-OTM condor: P&L is ~0 everywhere near spot → no phantom breakevens
        let req = AnalyseRequest {
            spot: 5800.0, rate: 0.04, div_yield: 0.0, model: Model::European,
            legs: vec![leg(Kind::Put, true, 5400.0, 0.25), leg(Kind::Put, false, 5600.0, 0.25), leg(Kind::Call, false, 6000.0, 0.25), leg(Kind::Call, true, 6200.0, 0.25)],
            iv_shift: 0.0, range: 0.15, n_prices: 61, n_dates: 10, at_days: vec![],
        };
        let s = analyse(&req).unwrap().summary;
        assert!(s.pop.unwrap() < 0.01, "pop {:?}", s.pop);
        assert_eq!(s.breakevens.len(), 0, "{:?}", s.breakevens);
    }
}
