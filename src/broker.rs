//! HTTP routes under `/api/broker/*`: the platform's one TWS connection.
//!
//! The market sidecar owns the only TWS session (client id `IBKR_CLIENT_ID`, read-only,
//! no order sends). Every module reaches it through these routes: the analyser for market
//! data (`/api/market/*`), the journal for fills, and the portfolio for positions and cash.
//! Nothing here connects on its own; `connect` is one attempt per press.
//!
//! Conventions match `/api/market/*`: success bodies are the sidecar's data as is, errors
//! are `{ "error": "..." }`. TWS not connected → 409 with the sidecar's message.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::market::{
    self, ApiError, ApiResult, MarketError, Sidecar, market_error, require_json,
};

const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Executions wait for commission reports and positions for TWS's full list. The sidecar
/// allows TWS 15 s plus 3 s for commission reports; this leaves a margin above that.
pub(crate) const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(25);

pub fn router(sidecar: Arc<Sidecar>) -> Router {
    router_with(sidecar, ACCOUNT_TIMEOUT)
}

/// `account_timeout` bounds executions and positions (tests shorten it).
fn router_with(sidecar: Arc<Sidecar>, account_timeout: Duration) -> Router {
    Router::new()
        .route("/api/broker/status", get(market::status))
        .route("/api/broker/connect", post(market::connect))
        .route("/api/broker/disconnect", post(disconnect))
        .route("/api/broker/executions", get(executions))
        .route("/api/broker/positions", get(positions))
        .route("/api/broker/account", get(account))
        .with_state(Broker {
            sidecar,
            account_timeout,
        })
}

#[derive(Clone)]
struct Broker {
    sidecar: Arc<Sidecar>,
    account_timeout: Duration,
}

impl axum::extract::FromRef<Broker> for Arc<Sidecar> {
    fn from_ref(b: &Broker) -> Self {
        Arc::clone(&b.sidecar)
    }
}

type Shared = State<Broker>;

async fn op(sidecar: &Sidecar, name: &str, timeout: Duration) -> ApiResult {
    sidecar
        .call(name, json!({}), timeout)
        .await
        .map(Json)
        .map_err(|e| broker_error(name, e))
}

/// Like `market_error`, but an unexpected sidecar failure keeps its message: on account
/// reads the user needs to know what TWS said, not only that something failed.
fn broker_error(op: &str, e: MarketError) -> ApiError {
    match e {
        MarketError::Failed(msg) => {
            eprintln!("[broker] {op} failed: {msg}");
            ApiError::new(StatusCode::BAD_GATEWAY, format!("broker request failed: {msg}"))
        }
        other => market_error(op, other),
    }
}

/// Drops the TWS session. JSON content type required, like `connect`.
async fn disconnect(State(b): Shared, headers: HeaderMap) -> ApiResult {
    require_json(&headers)?;
    op(&b.sidecar, "disconnect", DISCONNECT_TIMEOUT).await
}

async fn executions(State(b): Shared) -> ApiResult {
    op(&b.sidecar, "executions", b.account_timeout).await
}

async fn positions(State(b): Shared) -> ApiResult {
    op(&b.sidecar, "positions", b.account_timeout).await
}

/// Cash, net liquidation, available funds and buying power, per account. Read-only.
async fn account(State(b): Shared) -> ApiResult {
    op(&b.sidecar, "account", b.account_timeout).await
}

#[cfg(test)]
mod tests;
