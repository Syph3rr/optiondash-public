//! HTTP routes under `/api/market/*`.
//!
//! Requests are validated here, before anything reaches the sidecar. Replies from the
//! sidecar get IV added for `quotes` and `chain`; errors become `{ "error": "..." }`
//! with a short message (the details go to stderr).

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::iv::{IvContext, positive, valid_expiry, valid_symbol, with_iv};
use super::{MarketError, Sidecar};
use engine::Model;

/// Most contracts one `quotes` request may carry.
const MAX_CONTRACTS: usize = 32;
const MAX_TRADING_CLASS_LEN: usize = 16;
const SHORT_TIMEOUT: Duration = Duration::from_secs(3);
const LONG_TIMEOUT: Duration = Duration::from_secs(15);

pub fn router(sidecar: Arc<Sidecar>) -> Router {
    Router::new()
        .route("/api/market/status", get(status))
        .route("/api/market/connect", post(connect))
        .route("/api/market/underlying/{symbol}", get(underlying))
        .route("/api/market/expiries/{symbol}", get(expiries))
        .route("/api/market/earnings/{symbol}", get(earnings))
        .route("/api/market/strikes/{symbol}", get(strikes))
        .route("/api/market/quotes", post(quotes))
        .route("/api/market/chain", post(chain))
        .with_state(sidecar)
}

// ------------------------------------------------------------------ errors

pub(crate) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Maps a sidecar failure to a status and a short message. Only the offline reason is
/// shown as is (it is written for the user); everything else is logged and summarised.
pub(crate) fn market_error(op: &str, e: MarketError) -> ApiError {
    eprintln!("[market] {op} failed: {e:?}");
    let (status, message) = match e {
        MarketError::Offline(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("market data offline: {reason}"),
        ),
        MarketError::Timeout => (
            StatusCode::GATEWAY_TIMEOUT,
            "market data request timed out".to_string(),
        ),
        MarketError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            "no market data found for that request".to_string(),
        ),
        MarketError::Failed(_) => (
            StatusCode::BAD_GATEWAY,
            "market data request failed".to_string(),
        ),
        // Written for the user ("press Connect", "try again"), so shown as is.
        MarketError::NotConnected(reason) | MarketError::Busy(reason) => {
            (StatusCode::CONFLICT, reason)
        }
        MarketError::TwsTimeout(reason) => (StatusCode::GATEWAY_TIMEOUT, reason),
    };
    ApiError { status, message }
}

fn bad_reply(op: &str) -> ApiError {
    eprintln!("[market] {op}: sidecar reply had an unexpected shape");
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        message: "market data reply was malformed".into(),
    }
}

pub(crate) type ApiResult = Result<Json<Value>, ApiError>;

// ---------------------------------------------------------------- requests

/// What the IV solve needs; shared by the `quotes` and `chain` bodies.
#[derive(Deserialize)]
struct Pricing {
    spot: Option<f64>,
    rate: f64,
    #[serde(default)]
    div_yield: f64,
    model: Model,
}

impl Pricing {
    fn validate(&self) -> Result<(), ApiError> {
        if self.spot.is_some_and(|s| !s.is_finite() || s <= 0.0) {
            return Err(ApiError::bad_request("spot must be a positive number"));
        }
        if !self.rate.is_finite() || !self.div_yield.is_finite() {
            return Err(ApiError::bad_request("rate and div_yield must be numbers"));
        }
        Ok(())
    }

    /// The solve context; `reply_spot` is the spot the sidecar reply offered, if any.
    fn context(&self, reply_spot: Option<f64>) -> IvContext {
        IvContext {
            spot: reply_spot.or(self.spot),
            rate: self.rate,
            div_yield: self.div_yield,
            model: self.model,
        }
    }
}

#[derive(Deserialize)]
struct ContractReq {
    symbol: String,
    expiry: String,
    strike: f64,
    right: String,
    trading_class: String,
}

#[derive(Deserialize)]
struct QuotesReq {
    symbol: String,
    contracts: Vec<ContractReq>,
    #[serde(flatten)]
    pricing: Pricing,
}

#[derive(Deserialize)]
struct ChainReq {
    symbol: String,
    expiry: String,
    trading_class: String,
    #[serde(flatten)]
    pricing: Pricing,
}

/// Missing fields stay empty, so they fail the same validation as bad ones.
#[derive(Deserialize)]
struct StrikesQuery {
    #[serde(default)]
    expiry: String,
    #[serde(default)]
    trading_class: String,
    right: Option<String>,
}

/// A cross-site form can POST here without a preflight, but it cannot send JSON's content type.
/// This route takes raw bytes, so unlike `/api/analyze` nothing else checks it.
pub(crate) fn require_json(headers: &HeaderMap) -> Result<(), ApiError> {
    let is_json = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"));
    if is_json {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            message: "content type must be application/json".into(),
        })
    }
}

fn parse<T: for<'de> Deserialize<'de>>(body: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))
}

fn check_symbol(symbol: &str) -> Result<(), ApiError> {
    if valid_symbol(symbol) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "symbol must be 1-10 characters of A-Z, 0-9, dot or dash",
        ))
    }
}

fn check_expiry(expiry: &str) -> Result<(), ApiError> {
    if valid_expiry(expiry) {
        Ok(())
    } else {
        Err(ApiError::bad_request("expiry must be a date as YYYYMMDD"))
    }
}

fn check_trading_class(tc: &str) -> Result<(), ApiError> {
    let ok = !tc.is_empty()
        && tc.len() <= MAX_TRADING_CLASS_LEN
        && tc
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request("trading_class is missing or invalid"))
    }
}

fn check_right(right: &str) -> Result<(), ApiError> {
    if right == "C" || right == "P" {
        Ok(())
    } else {
        Err(ApiError::bad_request("right must be C or P"))
    }
}

/// Validates one contract against the request symbol and returns the fields to forward.
fn contract_args(c: &ContractReq, symbol: &str) -> Result<Value, ApiError> {
    if c.symbol != symbol {
        return Err(ApiError::bad_request(
            "every contract symbol must match the request symbol",
        ));
    }
    check_expiry(&c.expiry)?;
    check_trading_class(&c.trading_class)?;
    if !c.strike.is_finite() || c.strike <= 0.0 {
        return Err(ApiError::bad_request("strike must be a positive number"));
    }
    check_right(&c.right)?;
    Ok(
        json!({ "symbol": c.symbol, "expiry": c.expiry, "strike": c.strike,
               "right": c.right, "trading_class": c.trading_class }),
    )
}

// ---------------------------------------------------------------- handlers

type Shared = State<Arc<Sidecar>>;

pub(crate) async fn status(State(sidecar): Shared) -> Json<Value> {
    let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_owned);
    match sidecar.call("status", json!({}), SHORT_TIMEOUT).await {
        Ok(data) => Json(json!({
            "sidecar": "online",
            "ibkr": text(data.get("ibkr")),
            "reason": text(data.get("reason")),
        })),
        Err(e) => {
            eprintln!("[market] status failed: {e:?}");
            let reason = sidecar.offline_reason().unwrap_or_else(|| match e {
                MarketError::Timeout => "sidecar did not answer in time".into(),
                _ => "sidecar returned an error".into(),
            });
            Json(json!({ "sidecar": "offline", "ibkr": "disconnected", "reason": reason }))
        }
    }
}

/// One attempt to reach TWS. Answers with the status it left behind, connected or not.
pub(crate) async fn connect(State(sidecar): Shared, headers: HeaderMap) -> ApiResult {
    require_json(&headers)?;
    sidecar
        .call("connect", json!({}), LONG_TIMEOUT)
        .await
        .map(Json)
        .map_err(|e| market_error("connect", e))
}

async fn symbol_op(sidecar: &Sidecar, op: &str, symbol: &str, timeout: Duration) -> ApiResult {
    check_symbol(symbol)?;
    sidecar
        .call(op, json!({ "symbol": symbol }), timeout)
        .await
        .map(Json)
        .map_err(|e| market_error(op, e))
}

async fn underlying(State(sidecar): Shared, Path(symbol): Path<String>) -> ApiResult {
    symbol_op(&sidecar, "underlying", &symbol, SHORT_TIMEOUT).await
}

async fn expiries(State(sidecar): Shared, Path(symbol): Path<String>) -> ApiResult {
    symbol_op(&sidecar, "expiries", &symbol, LONG_TIMEOUT).await
}

/// The next report date from Yahoo; `date` is null for funds, indices and unknown dates.
async fn earnings(State(sidecar): Shared, Path(symbol): Path<String>) -> ApiResult {
    symbol_op(&sidecar, "earnings", &symbol, LONG_TIMEOUT).await
}

async fn strikes(
    State(sidecar): Shared,
    Path(symbol): Path<String>,
    query: Result<Query<StrikesQuery>, QueryRejection>,
) -> ApiResult {
    let Query(q) = query.map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))?;
    check_symbol(&symbol)?;
    check_expiry(&q.expiry)?;
    check_trading_class(&q.trading_class)?;
    let mut args =
        json!({ "symbol": symbol, "expiry": q.expiry, "trading_class": q.trading_class });
    if let Some(right) = q.right {
        check_right(&right)?;
        args["right"] = json!(right);
    }
    sidecar
        .call("strikes", args, LONG_TIMEOUT)
        .await
        .map(Json)
        .map_err(|e| market_error("strikes", e))
}

async fn quotes(State(sidecar): Shared, headers: HeaderMap, body: Bytes) -> ApiResult {
    require_json(&headers)?;
    let req: QuotesReq = parse(&body)?;
    check_symbol(&req.symbol)?;
    req.pricing.validate()?;
    if req.contracts.len() > MAX_CONTRACTS {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_CONTRACTS} contracts per request"
        )));
    }
    let contracts = req
        .contracts
        .iter()
        .map(|c| contract_args(c, &req.symbol))
        .collect::<Result<Vec<_>, _>>()?;
    let args = json!({ "symbol": req.symbol, "contracts": contracts });
    let data = sidecar
        .call("quotes", args, SHORT_TIMEOUT)
        .await
        .map_err(|e| market_error("quotes", e))?;
    let underlying_price =
        |obj: &Map<String, Value>| positive(obj.get("underlying").and_then(|u| u.get("price")));
    enrich(data, "quotes", "quotes", underlying_price, &req.pricing)
}

async fn chain(State(sidecar): Shared, headers: HeaderMap, body: Bytes) -> ApiResult {
    require_json(&headers)?;
    let req: ChainReq = parse(&body)?;
    check_symbol(&req.symbol)?;
    check_expiry(&req.expiry)?;
    check_trading_class(&req.trading_class)?;
    req.pricing.validate()?;
    let mut args = json!({ "symbol": req.symbol, "expiry": req.expiry,
                           "trading_class": req.trading_class });
    if let Some(spot) = req.pricing.spot {
        args["spot"] = json!(spot);
    }
    let data = sidecar
        .call("chain", args, LONG_TIMEOUT)
        .await
        .map_err(|e| market_error("chain", e))?;
    let reply_spot = |obj: &Map<String, Value>| positive(obj.get("spot"));
    enrich(data, "chain", "rows", reply_spot, &req.pricing)
}

/// Adds IV to every row of `data[rows_key]`. The solve spot is the one `reply_spot` finds in
/// the reply, else the request's.
fn enrich(
    data: Value,
    op: &str,
    rows_key: &str,
    reply_spot: impl Fn(&Map<String, Value>) -> Option<f64>,
    pricing: &Pricing,
) -> ApiResult {
    let Value::Object(mut obj) = data else {
        return Err(bad_reply(op));
    };
    let Some(Value::Array(rows)) = obj.remove(rows_key) else {
        return Err(bad_reply(op));
    };
    let ctx = pricing.context(reply_spot(&obj));
    let rows = rows.into_iter().map(|r| with_iv(r, &ctx)).collect();
    obj.insert(rows_key.to_string(), Value::Array(rows));
    Ok(Json(Value::Object(obj)))
}

#[cfg(test)]
mod tests;
