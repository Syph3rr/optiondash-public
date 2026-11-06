//! Broker route tests over a real Python fake sidecar (`tests/fixtures/fake_sidecar.py`).
//! No TWS: the fake answers from canned replies.

use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::market::SidecarConfig;
use crate::security;

const FAKE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake_sidecar.py"
);
const NOT_CONNECTED: &str = "not connected to TWS; press Connect IBKR";

fn python() -> String {
    std::env::var("OPTIONDASH_PYTHON").unwrap_or_else(|_| "python".into())
}

/// A sidecar answering from `canned`; waits until it replies to a probe.
async fn sidecar(mode: &str, canned: Option<Value>) -> Arc<Sidecar> {
    let mut cfg = SidecarConfig::new(python(), FAKE);
    cfg.args = vec![mode.into()];
    if let Some(c) = canned {
        cfg.args.push(c.to_string());
    }
    let s = Sidecar::spawn(cfg);
    if mode == "hang" {
        // Up once calls time out instead of failing as offline at once.
        let deadline = Instant::now() + Duration::from_secs(15);
        while !matches!(
            s.call("probe", json!({}), Duration::from_millis(100)).await,
            Err(crate::market::MarketError::Timeout)
        ) {
            assert!(Instant::now() < deadline, "hanging fake never started");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        return s;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while s
        .call("probe", json!({}), Duration::from_secs(1))
        .await
        .is_err()
    {
        assert!(Instant::now() < deadline, "fake sidecar never answered");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    s
}

async fn send(app: Router, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn get_req(path: &str) -> Request<Body> {
    Request::get(path)
        .header("host", "127.0.0.1:3000")
        .body(Body::empty())
        .unwrap()
}

fn post_req(path: &str) -> Request<Body> {
    Request::post(path)
        .header("host", "127.0.0.1:3000")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap()
}

#[tokio::test]
async fn executions_and_positions_return_sidecar_data_as_is() {
    let s = sidecar("canned", Some(json!({
        "executions": {"data": {"executions": [{"exec_id": "e1", "qty": -1.0}], "as_of": "t"}},
        "positions": {"data": {"positions": [{"symbol": "SPY", "position": 2.0}], "as_of": "t"}},
    })))
    .await;
    let (st, body) = send(router(Arc::clone(&s)), get_req("/api/broker/executions")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        body,
        json!({"executions": [{"exec_id": "e1", "qty": -1.0}], "as_of": "t"})
    );
    let (st, body) = send(router(s), get_req("/api/broker/positions")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["positions"][0]["symbol"], "SPY");
}

#[tokio::test]
async fn account_returns_the_sidecar_cash_summary_as_is() {
    let s = sidecar(
        "canned",
        Some(json!({"account": {"data": {
            "accounts": [{"account": "DU1", "currency": "USD", "cash": 1234.5, "net_liquidation": 5000.0,
                          "available_funds": null, "buying_power": null}],
            "as_of": "t"}}})),
    )
    .await;
    let (st, body) = send(router(s), get_req("/api/broker/account")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["accounts"][0]["cash"], 1234.5);
    assert_eq!(body["accounts"][0]["available_funds"], Value::Null);
}

#[tokio::test]
async fn account_errors_map_like_the_other_account_reads() {
    let s = sidecar(
        "canned",
        Some(json!({"account": {"error": "TWS is offline", "code": "not_connected"}})),
    )
    .await;
    let (st, body) = send(router(Arc::clone(&s)), get_req("/api/broker/account")).await;
    assert_eq!((st, body), (StatusCode::CONFLICT, json!({"error": "TWS is offline"})));
    let s = sidecar("canned", Some(json!({"account": {"error": "boom"}}))).await;
    let (st, body) = send(router(s), get_req("/api/broker/account")).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "broker request failed: boom"}));
}

#[tokio::test]
async fn account_is_read_only_no_other_method_is_routed() {
    let s = sidecar("canned", Some(json!({"account": {"data": {"accounts": [], "as_of": "t"}}}))).await;
    for method in ["POST", "PUT", "DELETE"] {
        let req = Request::builder()
            .method(method)
            .uri("/api/broker/account")
            .header("host", "127.0.0.1:3000")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let (st, _) = send(router(Arc::clone(&s)), req).await;
        assert_eq!(st, StatusCode::METHOD_NOT_ALLOWED, "{method}");
    }
}

#[tokio::test]
async fn not_connected_is_409_with_the_sidecar_message() {
    let s = sidecar(
        "canned",
        Some(json!({
            "executions": {"error": NOT_CONNECTED},
            "positions": {"error": "TWS is offline", "code": "not_connected"},
        })),
    )
    .await;
    let (st, body) = send(router(Arc::clone(&s)), get_req("/api/broker/executions")).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body, json!({"error": NOT_CONNECTED}));
    let (st, body) = send(router(s), get_req("/api/broker/positions")).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body, json!({"error": "TWS is offline"}));
}

#[tokio::test]
async fn other_sidecar_errors_are_502_with_the_sidecar_message() {
    let s = sidecar("canned", Some(json!({"executions": {"error": "boom"}}))).await;
    let (st, body) = send(router(s), get_req("/api/broker/executions")).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "broker request failed: boom"}));
}

#[tokio::test]
async fn sidecar_codes_map_to_their_statuses() {
    let lost = "connection to TWS was lost; press Connect IBKR";
    let busy = "another account request is running; try again in a moment";
    let slow = "TWS did not answer the executions request within 15s; try again";
    let s = sidecar(
        "canned",
        Some(json!({
            "executions": {"error": lost},
            "positions": {"error": busy, "code": "busy"},
            "disconnect": {"error": slow, "code": "timeout"},
        })),
    )
    .await;
    let (st, body) = send(router(Arc::clone(&s)), get_req("/api/broker/executions")).await;
    assert_eq!((st, body), (StatusCode::CONFLICT, json!({"error": lost})));
    let (st, body) = send(router(Arc::clone(&s)), get_req("/api/broker/positions")).await;
    assert_eq!((st, body), (StatusCode::CONFLICT, json!({"error": busy})));
    let (st, body) = send(router(s), post_req("/api/broker/disconnect")).await;
    assert_eq!((st, body), (StatusCode::GATEWAY_TIMEOUT, json!({"error": slow})));
}

#[test]
fn timeouts_nest_sidecar_gateway_journal_proxy() {
    // sidecar: 15 s TWS + 3 s commissions; journal client: 30 s.
    assert!(ACCOUNT_TIMEOUT >= Duration::from_secs(25));
    assert!(ACCOUNT_TIMEOUT < Duration::from_secs(30));
    assert!(crate::proxy::RESPONSE_TIMEOUT > Duration::from_secs(30));
}

#[tokio::test]
async fn status_connect_disconnect_round_trip() {
    let state = json!({"ibkr": "disconnected", "reason": NOT_CONNECTED});
    let s = sidecar(
        "canned",
        Some(json!({
            "status": {"data": state},
            "connect": {"data": {"ibkr": "connected", "reason": null}},
            "disconnect": {"data": state},
        })),
    )
    .await;
    let (st, body) = send(router(Arc::clone(&s)), get_req("/api/broker/status")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        body,
        json!({"sidecar": "online", "ibkr": "disconnected", "reason": NOT_CONNECTED})
    );
    let (st, body) = send(router(Arc::clone(&s)), post_req("/api/broker/connect")).await;
    assert_eq!(
        (st, body["ibkr"].clone()),
        (StatusCode::OK, json!("connected"))
    );
    let (st, body) = send(router(s), post_req("/api/broker/disconnect")).await;
    assert_eq!((st, body), (StatusCode::OK, state));
}

#[tokio::test]
async fn connect_and_disconnect_need_a_json_body() {
    let s = sidecar("canned", Some(json!({}))).await;
    for path in ["/api/broker/connect", "/api/broker/disconnect"] {
        let req = Request::post(path)
            .header("host", "127.0.0.1")
            .body(Body::empty())
            .unwrap();
        let (st, _) = send(router(Arc::clone(&s)), req).await;
        assert_eq!(st, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{path}");
    }
}

#[tokio::test]
async fn slow_tws_times_out_with_the_market_timeout_status() {
    let s = sidecar("hang", None).await;
    let app = router_with(s, Duration::from_millis(300));
    let (st, body) = send(app, get_req("/api/broker/executions")).await;
    assert_eq!(st, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(body, json!({"error": "market data request timed out"}));
}

#[tokio::test]
async fn security_layer_guards_broker_routes() {
    let s = sidecar(
        "canned",
        Some(json!({"connect": {"data": {"ibkr": "connected"}}})),
    )
    .await;
    let app = || router(Arc::clone(&s)).layer(axum::middleware::from_fn(security::local_only));
    let cross = Request::post("/api/broker/connect")
        .header("host", "127.0.0.1:3000")
        .header("origin", "https://evil.example")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(send(app(), cross).await.0, StatusCode::FORBIDDEN);
    let foreign = Request::get("/api/broker/executions")
        .header("host", "evil.example:3000")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(app(), foreign).await.0, StatusCode::BAD_REQUEST);
    let local = Request::post("/api/broker/connect")
        .header("host", "127.0.0.1:3000")
        .header("origin", "http://127.0.0.1:3000")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(send(app(), local).await.0, StatusCode::OK);
}
