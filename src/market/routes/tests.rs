//! Route tests: a real axum router over a real TCP port, backed by a real Python
//! subprocess (`tests/fixtures/fake_sidecar.py` in `canned` mode). No TWS, no Yahoo.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;
use engine::{Kind, Mkt, Model, unit_price};
use crate::market::{MarketError, SidecarConfig};

const FAKE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake_sidecar.py"
);
const RATE: f64 = 0.04;
const DTE: f64 = 90.0;

fn python() -> String {
    std::env::var("OPTIONDASH_PYTHON").unwrap_or_else(|_| "python".into())
}

/// Serves the router on an ephemeral port; keeps the sidecar alive for the test.
struct Server {
    addr: SocketAddr,
    _sidecar: Arc<Sidecar>,
}

async fn serve(cfg: SidecarConfig) -> Server {
    let sidecar = Sidecar::spawn(cfg);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(Arc::clone(&sidecar));
    tokio::spawn(async move { axum::serve(listener, app).await });
    Server {
        addr,
        _sidecar: sidecar,
    }
}

/// A server whose sidecar answers from `canned` (op -> {data, echo} or {error, code}).
async fn online(canned: Value) -> Server {
    let mut cfg = SidecarConfig::new(python(), FAKE);
    cfg.args = vec!["canned".into(), canned.to_string()];
    let server = serve(cfg).await;
    let deadline = Instant::now() + Duration::from_secs(15);
    while server._sidecar.inner.lock().writer.is_none() {
        assert!(Instant::now() < deadline, "sidecar never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    server
}

/// A server whose sidecar can never start: anything reaching it answers 503.
async fn offline() -> Server {
    let mut cfg = SidecarConfig::new("optiondash-no-such-python-binary", FAKE);
    cfg.backoff_min = Duration::from_secs(5);
    let server = serve(cfg).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !server
        ._sidecar
        .offline_reason()
        .is_some_and(|r| r.contains("failed to start"))
    {
        assert!(Instant::now() < deadline, "offline reason never appeared");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    server
}

async fn request(addr: SocketAddr, method: &str, path: &str, body: Option<&str>) -> (u16, Value) {
    let header = "Content-Type: application/json\r\n";
    send(addr, method, path, header, body.unwrap_or("")).await
}

/// `headers` is any number of complete header lines, so a test can leave one out.
async fn send(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &str,
    body: &str,
) -> (u16, Value) {
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\
         {headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8(raw).unwrap();
    let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    if body.is_empty() {
        return (status, Value::Null);
    }
    let json = serde_json::from_str(body).unwrap_or_else(|e| panic!("body {body:?}: {e}"));
    (status, json)
}

async fn get(s: &Server, path: &str) -> (u16, Value) {
    request(s.addr, "GET", path, None).await
}

async fn post(s: &Server, path: &str, body: &Value) -> (u16, Value) {
    request(s.addr, "POST", path, Some(&body.to_string())).await
}

fn price(kind: Kind, strike: f64, iv: f64) -> f64 {
    let m = Mkt {
        rate: RATE,
        q: 0.0,
        model: Model::European,
    };
    unit_price(kind, 100.0, strike, DTE, iv, m)
}

fn close(v: &Value, want: f64) {
    let got = v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"));
    assert!((got - want).abs() < 1e-4, "got {got}, want {want}");
}

fn contract(strike: f64, right: &str) -> Value {
    json!({ "symbol": "SPX", "expiry": "20261120", "strike": strike, "right": right,
            "trading_class": "SPXW" })
}

fn quotes_body(extra: Value) -> Value {
    let mut body = json!({ "symbol": "SPX", "contracts": [contract(100.0, "C")],
        "rate": RATE, "div_yield": 0.0, "model": "european" });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    body
}

fn chain_body(extra: Value) -> Value {
    let mut body = json!({ "symbol": "SPX", "expiry": "20261120", "trading_class": "SPXW",
        "rate": RATE, "div_yield": 0.0, "model": "european" });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    body
}

fn live_row(right: &str, strike: f64, mark: Value) -> Value {
    json!({ "symbol": "SPX", "expiry": "20261120", "strike": strike, "right": right,
            "trading_class": "SPXW", "dte": DTE, "mark": mark, "bid": 1.0,
            "ibkr_iv": 0.5, "iv": 0.00001, "source": "ibkr" })
}

// ------------------------------------------------------------------ status

#[tokio::test]
async fn status_reports_online_with_the_ibkr_state() {
    let s = online(json!({ "status": { "data": { "ibkr": "disconnected",
        "reason": "TWS is not running" } } }))
    .await;
    let (code, body) = get(&s, "/api/market/status").await;
    assert_eq!(code, 200);
    assert_eq!(
        body,
        json!({ "sidecar": "online", "ibkr": "disconnected", "reason": "TWS is not running" })
    );
}

#[tokio::test]
async fn connect_returns_the_status_from_the_attempt() {
    let s = online(json!({ "connect": { "data": { "ibkr": "disconnected",
        "reason": "TWS not reachable on 127.0.0.1:7496" } } }))
    .await;
    let (code, body) = post(&s, "/api/market/connect", &json!({})).await;
    assert_eq!(code, 200);
    assert_eq!(body["ibkr"], "disconnected");
    assert_eq!(body["reason"], "TWS not reachable on 127.0.0.1:7496");
}

#[tokio::test]
async fn connect_answers_503_with_the_sidecar_down() {
    let s = offline().await;
    let (code, body) = post(&s, "/api/market/connect", &json!({})).await;
    assert_eq!(code, 503, "{body}");
}

#[tokio::test]
async fn connect_refuses_a_post_that_is_not_json() {
    let s = offline().await; // anything reaching the sidecar here answers 503
    let (code, _) = send(
        s.addr,
        "POST",
        "/api/market/connect",
        "Content-Type: text/plain\r\n",
        "{}",
    )
    .await;
    assert_eq!(code, 415);
}

#[tokio::test]
async fn connect_is_post_only() {
    let s = online(json!({})).await;
    let (code, _) = get(&s, "/api/market/connect").await;
    assert_eq!(code, 405);
}

#[tokio::test]
async fn status_is_200_and_offline_with_a_reason_when_the_sidecar_is_down() {
    let s = offline().await;
    let (code, body) = get(&s, "/api/market/status").await;
    assert_eq!(code, 200);
    assert_eq!(body["sidecar"], "offline");
    assert_eq!(body["ibkr"], "disconnected");
    assert!(
        body["reason"].as_str().unwrap().contains("failed to start"),
        "{body}"
    );
}

// ----------------------------------------------------------- error mapping

#[tokio::test]
async fn offline_sidecar_returns_503() {
    let s = offline().await;
    for (code, body) in [
        get(&s, "/api/market/underlying/SPX").await,
        get(&s, "/api/market/expiries/SPX").await,
        post(&s, "/api/market/quotes", &quotes_body(json!({}))).await,
        post(&s, "/api/market/chain", &chain_body(json!({}))).await,
    ] {
        assert_eq!(code, 503, "{body}");
        let msg = body["error"].as_str().unwrap();
        assert!(
            msg.contains("failed to start"),
            "the reason is for the user: {msg}"
        );
    }
}

#[tokio::test]
async fn unknown_symbol_returns_404() {
    let s = online(json!({
        "underlying": { "error": "no price or expiries for ZZZZ", "code": "not_found" },
        "expiries": { "error": "no expiries for ZZZZ", "code": "not_found" },
    }))
    .await;
    for path in ["/api/market/underlying/ZZZZ", "/api/market/expiries/ZZZZ"] {
        let (code, body) = get(&s, path).await;
        assert_eq!(code, 404, "{path}");
        assert!(body["error"].is_string());
    }
}

#[tokio::test]
async fn sidecar_failure_returns_502_without_internals() {
    let s = online(json!({ "underlying": { "error": "Traceback File C:\\secret\\x.py line 3" } }))
        .await;
    let (code, body) = get(&s, "/api/market/underlying/SPX").await;
    assert_eq!(code, 502);
    let msg = body["error"].as_str().unwrap();
    assert!(
        !msg.contains("secret") && !msg.contains("Traceback"),
        "{msg}"
    );
}

#[test]
fn market_errors_map_to_the_documented_statuses() {
    let cases = [
        (
            MarketError::Offline("why".into()),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (MarketError::Timeout, StatusCode::GATEWAY_TIMEOUT),
        (MarketError::NotFound("x".into()), StatusCode::NOT_FOUND),
        (
            MarketError::Failed("/etc/secret".into()),
            StatusCode::BAD_GATEWAY,
        ),
    ];
    for (err, want) in cases {
        let api = market_error("test", err);
        assert_eq!(api.status, want);
        assert!(!api.message.contains("/etc/secret"));
    }
    let offline = market_error("test", MarketError::Offline("TWS closed".into()));
    assert!(offline.message.contains("TWS closed"));
}

#[test]
fn user_facing_tws_errors_keep_their_message() {
    let cases = [
        (MarketError::NotConnected("press Connect".into()), StatusCode::CONFLICT),
        (MarketError::Busy("try again".into()), StatusCode::CONFLICT),
        (MarketError::TwsTimeout("TWS was slow".into()), StatusCode::GATEWAY_TIMEOUT),
    ];
    for (err, want) in cases {
        let text = err.to_string();
        let api = market_error("test", err);
        assert_eq!((api.status, api.message), (want, text));
    }
}

// ------------------------------------------------------------- passthrough

#[tokio::test]
async fn underlying_and_expiries_pass_the_sidecar_data_through() {
    let s = online(json!({
        "underlying": { "data": { "symbol": "SPX", "price": 5000.5, "source": "ibkr" },
                        "echo": true },
        "expiries": { "data": { "symbol": "SPX", "expiries": [] }, "echo": true },
    }))
    .await;
    let (code, body) = get(&s, "/api/market/underlying/SPX").await;
    assert_eq!(
        (code, &body["price"], &body["source"]),
        (200, &json!(5000.5), &json!("ibkr"))
    );
    assert_eq!(body["seen_args"], json!({ "symbol": "SPX" }));
    let (code, body) = get(&s, "/api/market/expiries/BRK.B").await;
    assert_eq!(code, 200);
    assert_eq!(body["seen_args"], json!({ "symbol": "BRK.B" }));
}

// ------------------------------------------------------------------ quotes

#[tokio::test]
async fn quotes_get_iv_solved_at_the_underlying_price_not_the_request_spot() {
    let mark = price(Kind::Call, 100.0, 0.20);
    let s = online(json!({ "quotes": { "data": {
        "underlying": { "price": 100.0, "source": "ibkr", "data_type": "live", "as_of": "t" },
        "quotes": [live_row("C", 100.0, json!(mark)), {
            "right": "C", "strike": 100.0, "dte": 0.0, "mark": 1.0, "ibkr_iv": 0.3 }],
    } } }))
    .await;
    let (code, body) = post(
        &s,
        "/api/market/quotes",
        &quotes_body(json!({ "spot": 50 })),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    let q = &body["quotes"];
    close(&q[0]["iv"], 0.20);
    assert_eq!(q[0]["iv_source"], "solved");
    assert!(q[0].get("ibkr_iv").is_none());
    assert_eq!(q[0]["bid"], 1.0);
    assert_eq!(q[1]["iv"], Value::Null);
    assert_eq!(q[1]["iv_source"], Value::Null);
    assert_eq!(
        body["underlying"]["price"], 100.0,
        "underlying passes through"
    );
}

#[tokio::test]
async fn quotes_use_the_request_spot_when_the_underlying_has_no_price() {
    let mark = price(Kind::Call, 100.0, 0.20);
    let data = json!({ "underlying": { "price": null, "source": null },
                       "quotes": [live_row("C", 100.0, json!(mark))] });
    let s = online(json!({ "quotes": { "data": data } })).await;
    let (_, body) = post(
        &s,
        "/api/market/quotes",
        &quotes_body(json!({ "spot": 100 })),
    )
    .await;
    close(&body["quotes"][0]["iv"], 0.20);
    // No spot anywhere: nothing to solve with, so IBKR's own IV is the answer.
    let (code, body) = post(&s, "/api/market/quotes", &quotes_body(json!({}))).await;
    assert_eq!(code, 200);
    assert_eq!(body["quotes"][0]["iv"], 0.5);
    assert_eq!(body["quotes"][0]["iv_source"], "ibkr");
}

#[tokio::test]
async fn quotes_requested_model_drives_the_solved_iv() {
    let mark = price(Kind::Call, 100.0, 0.20);
    let data = json!({ "underlying": { "price": 100.0 },
                       "quotes": [live_row("P", 110.0, json!(mark + 10.0))] });
    let s = online(json!({ "quotes": { "data": data } })).await;
    let (_, euro) = post(&s, "/api/market/quotes", &quotes_body(json!({}))).await;
    let (_, amer) = post(
        &s,
        "/api/market/quotes",
        &quotes_body(json!({ "model": "american" })),
    )
    .await;
    let (e, a) = (
        euro["quotes"][0]["iv"].as_f64(),
        amer["quotes"][0]["iv"].as_f64(),
    );
    assert!(
        e.is_some() && a.is_some() && (e.unwrap() - a.unwrap()).abs() > 1e-3,
        "{e:?} {a:?}"
    );
}

#[tokio::test]
async fn quotes_forward_only_validated_contract_fields() {
    let s = online(
        json!({ "quotes": { "data": { "underlying": null, "quotes": [] },
                                        "echo": true } }),
    )
    .await;
    let mut c = contract(4500.0, "P");
    c["evil"] = json!("x");
    let body = quotes_body(json!({ "contracts": [c], "spot": 100 }));
    let (code, out) = post(&s, "/api/market/quotes", &body).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        out["seen_args"],
        json!({ "symbol": "SPX", "contracts": [contract(4500.0, "P")] })
    );
}

#[tokio::test]
async fn malformed_quotes_reply_is_a_502() {
    let s = online(json!({ "quotes": { "data": { "nope": 1 } } })).await;
    let (code, _) = post(&s, "/api/market/quotes", &quotes_body(json!({}))).await;
    assert_eq!(code, 502);
}

#[tokio::test]
async fn thirty_two_contracts_are_accepted() {
    let s = online(json!({ "quotes": { "data": { "underlying": null, "quotes": [] } } })).await;
    let contracts: Vec<Value> = (1..=32).map(|k| contract(f64::from(k), "C")).collect();
    let (code, _) = post(
        &s,
        "/api/market/quotes",
        &quotes_body(json!({ "contracts": contracts })),
    )
    .await;
    assert_eq!(code, 200);
}

/// The page polls with no contracts when no leg is linked, so spot keeps updating.
#[tokio::test]
async fn empty_contracts_still_return_the_underlying() {
    let s = online(json!({ "quotes": { "echo": true, "data": {
        "underlying": { "price": 100.0 }, "quotes": [] } } }))
    .await;
    let (code, body) = post(
        &s,
        "/api/market/quotes",
        &quotes_body(json!({ "contracts": [] })),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(body["underlying"]["price"], 100.0);
    assert_eq!(body["quotes"], json!([]));
    assert_eq!(body["seen_args"]["contracts"], json!([]));
}

// ----------------------------------------------------------------- strikes

const STRIKES_QUERY: &str = "expiry=20261120&trading_class=SPXW";

#[tokio::test]
async fn strikes_forward_only_validated_args_and_pass_the_reply_through() {
    let data = json!({ "symbol": "SPX", "expiry": "20261120", "trading_class": "SPXW",
                       "strikes": [7000.0, 7005.0] });
    let s = online(json!({ "strikes": { "data": data, "echo": true } })).await;
    let path = format!("/api/market/strikes/SPX?{STRIKES_QUERY}&extra=ignored");
    let (code, body) = get(&s, &path).await;
    assert_eq!(code, 200);
    assert_eq!(body["strikes"], json!([7000.0, 7005.0]));
    assert_eq!(
        body["seen_args"],
        json!({ "symbol": "SPX", "expiry": "20261120", "trading_class": "SPXW" })
    );
}

#[tokio::test]
async fn strikes_forward_a_right_only_when_one_is_given() {
    let data = json!({ "strikes": [7000.0] });
    let s = online(json!({ "strikes": { "data": data, "echo": true } })).await;
    let (code, body) = get(
        &s,
        &format!("/api/market/strikes/SPX?{STRIKES_QUERY}&right=P"),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(
        body["seen_args"],
        json!({ "symbol": "SPX", "expiry": "20261120", "trading_class": "SPXW", "right": "P" })
    );
    let (_, body) = get(&s, &format!("/api/market/strikes/SPX?{STRIKES_QUERY}")).await;
    assert_eq!(body["seen_args"].get("right"), None);
}

#[tokio::test]
async fn strikes_map_sidecar_errors_like_the_other_routes() {
    let s = online(json!({ "strikes": { "error": "no strikes", "code": "not_found" } })).await;
    let (code, body) = get(&s, &format!("/api/market/strikes/ZZZZ?{STRIKES_QUERY}")).await;
    assert_eq!(code, 404);
    assert!(body["error"].is_string());
    let s = offline().await;
    let (code, body) = get(&s, &format!("/api/market/strikes/SPX?{STRIKES_QUERY}")).await;
    assert_eq!(code, 503);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn invalid_strikes_requests_return_400_json_before_reaching_the_sidecar() {
    // The sidecar is down, so a request that got past validation would answer 503.
    let s = offline().await;
    for path in [
        "/api/market/strikes/SPX",
        "/api/market/strikes/SPX?expiry=20261120",
        "/api/market/strikes/SPX?trading_class=SPXW",
        "/api/market/strikes/SPX?expiry=2026-11-20&trading_class=SPXW",
        "/api/market/strikes/SPX?expiry=20261120&trading_class=",
        "/api/market/strikes/SPX?expiry=20261120&trading_class=a%20b",
        "/api/market/strikes/SPX?expiry=1&expiry=2&trading_class=SPXW",
        "/api/market/strikes/spx?expiry=20261120&trading_class=SPXW",
        "/api/market/strikes/SPX?expiry=20261120&trading_class=SPXW&right=X",
        "/api/market/strikes/SPX?expiry=20261120&trading_class=SPXW&right=",
        "/api/market/strikes/SPX?expiry=20261120&trading_class=SPXW&right=c",
    ] {
        let (code, body) = get(&s, path).await;
        assert_eq!(code, 400, "{path}");
        assert!(body["error"].is_string(), "{path}");
    }
}

// ------------------------------------------------------------------- chain

#[tokio::test]
async fn chain_rows_are_solved_at_the_response_spot() {
    let mark = price(Kind::Call, 100.0, 0.20);
    let data = json!({ "expiry": "20261120", "trading_class": "SPXW", "dte": DTE,
                       "spot": 100.0, "rows": [live_row("C", 100.0, json!(mark))] });
    let s = online(json!({ "chain": { "data": data, "echo": true } })).await;
    let (code, body) = post(&s, "/api/market/chain", &chain_body(json!({ "spot": 50 }))).await;
    assert_eq!(code, 200, "{body}");
    close(&body["rows"][0]["iv"], 0.20);
    assert_eq!(body["rows"][0]["iv_source"], "solved");
    assert!(body["rows"][0].get("ibkr_iv").is_none());
    assert_eq!(body["spot"], 100.0);
    assert_eq!(
        body["seen_args"],
        json!({ "symbol": "SPX", "expiry": "20261120", "trading_class": "SPXW", "spot": 50.0 })
    );
}

#[tokio::test]
async fn chain_without_spot_omits_it_and_falls_back_to_the_request_spot_for_iv() {
    let mark = price(Kind::Call, 100.0, 0.20);
    let data = json!({ "spot": null, "rows": [live_row("C", 100.0, json!(mark))] });
    let s = online(json!({ "chain": { "data": data, "echo": true } })).await;
    let (_, body) = post(&s, "/api/market/chain", &chain_body(json!({}))).await;
    assert_eq!(body["seen_args"].get("spot"), None);
    assert_eq!(body["rows"][0]["iv"], 0.5, "no spot at all: IBKR's own IV");
    let (_, body) = post(&s, "/api/market/chain", &chain_body(json!({ "spot": 100 }))).await;
    close(&body["rows"][0]["iv"], 0.20);
}

// -------------------------------------------------------------- validation

#[tokio::test]
async fn invalid_requests_return_400_before_reaching_the_sidecar() {
    // The sidecar is down, so a request that got past validation would answer 503.
    let s = offline().await;
    for path in [
        "/api/market/underlying/spx",
        "/api/market/underlying/ABCDEFGHIJK",
        "/api/market/underlying/..%2Fx",
        "/api/market/expiries/A%20B",
    ] {
        let (code, body) = get(&s, path).await;
        assert_eq!(code, 400, "{path}");
        assert!(body["error"].is_string());
    }
    let many: Vec<Value> = (1..=33).map(|k| contract(f64::from(k), "C")).collect();
    let mut other_symbol = contract(100.0, "C");
    other_symbol["symbol"] = json!("NDX");
    let bad_quotes = [
        quotes_body(json!({ "symbol": "spx" })),
        quotes_body(json!({ "contracts": [other_symbol] })),
        quotes_body(json!({ "contracts": many })),
        quotes_body(json!({ "contracts": [contract(100.0, "X")] })),
        quotes_body(json!({ "contracts": [contract(0.0, "C")] })),
        quotes_body(json!({ "contracts": [contract(-5.0, "C")] })),
        quotes_body(
            json!({ "contracts": [{ "symbol": "SPX", "expiry": "2026-11-20",
            "strike": 100.0, "right": "C", "trading_class": "SPXW" }] }),
        ),
        quotes_body(
            json!({ "contracts": [{ "symbol": "SPX", "expiry": "20261120",
            "strike": 100.0, "right": "C", "trading_class": "" }] }),
        ),
        quotes_body(json!({ "spot": -5 })),
        quotes_body(json!({ "spot": 0 })),
        quotes_body(json!({ "model": "foo" })),
        quotes_body(json!({ "contracts": "nope" })),
    ];
    for body in bad_quotes {
        let (code, out) = post(&s, "/api/market/quotes", &body).await;
        assert_eq!(code, 400, "{body} -> {out}");
        assert!(out["error"].is_string());
    }
    let bad_chain = [
        chain_body(json!({ "symbol": "spx" })),
        chain_body(json!({ "expiry": "2026-11-20" })),
        chain_body(json!({ "expiry": "20261340" })),
        chain_body(json!({ "trading_class": "" })),
        chain_body(json!({ "spot": -1 })),
        chain_body(json!({ "model": "bogus" })),
    ];
    for body in bad_chain {
        let (code, out) = post(&s, "/api/market/chain", &body).await;
        assert_eq!(code, 400, "{body} -> {out}");
    }
    for raw in [
        "{",
        "",
        r#"{"symbol":"SPX","contracts":[],"model":"european"}"#,
        r#"{"symbol":"SPX","contracts":[],"rate":1e999,"model":"european"}"#,
    ] {
        let (code, _) = request(s.addr, "POST", "/api/market/quotes", Some(raw)).await;
        assert_eq!(code, 400, "{raw:?}");
    }
    let (code, _) = post(&s, "/api/market/quotes", &quotes_body(json!({}))).await;
    assert_eq!(code, 503, "a valid request does reach the sidecar");
}

// ------------------------------------------------------------- content type

const POST_ROUTES: [&str; 2] = ["/api/market/quotes", "/api/market/chain"];

fn post_body(path: &str) -> String {
    let body = if path.ends_with("quotes") {
        quotes_body(json!({}))
    } else {
        chain_body(json!({}))
    };
    body.to_string()
}

#[tokio::test]
async fn posts_that_are_not_json_are_refused_before_reaching_the_sidecar() {
    let s = offline().await; // anything reaching the sidecar here answers 503
    let headers = [
        "Content-Type: text/plain\r\n",
        "Content-Type: text/plain;charset=UTF-8\r\n",
        "Content-Type: application/x-www-form-urlencoded\r\n",
        "Content-Type: multipart/form-data; boundary=x\r\n",
        "Content-Type: application/jsonp\r\n",
        "",
    ];
    for path in POST_ROUTES {
        for header in headers {
            let (status, body) = send(s.addr, "POST", path, header, &post_body(path)).await;
            assert_eq!(status, 415, "{path} with {header:?}");
            assert_eq!(body["error"], "content type must be application/json");
        }
    }
}

#[tokio::test]
async fn json_posts_are_accepted_with_any_case_or_parameter() {
    let s = offline().await;
    for path in POST_ROUTES {
        for media in [
            "application/json",
            "application/json; charset=utf-8",
            "Application/JSON",
        ] {
            let header = format!("Content-Type: {media}\r\n");
            let (status, _) = send(s.addr, "POST", path, &header, &post_body(path)).await;
            assert_eq!(status, 503, "{path} with {media}");
        }
    }
}

#[tokio::test]
async fn earnings_pass_through_and_check_the_symbol() {
    let s = online(json!({
        "earnings": { "data": { "symbol": "AAPL", "date": "2026-11-03", "when": "amc" }, "echo": true },
    }))
    .await;
    let (code, body) = get(&s, "/api/market/earnings/AAPL").await;
    assert_eq!((code, &body["date"]), (200, &json!("2026-11-03")));
    assert_eq!(body["seen_args"], json!({ "symbol": "AAPL" }));
    let (code, _) = get(&s, "/api/market/earnings/aa%3Bpl").await;
    assert_eq!(code, 400);
}
