//! OptionDash gateway: the platform's front door.
//!
//! It serves the embedded pages and assets (see `assets`), exposes the pricing engine
//! (`engine` crate, OptionStratLib) at /api/analyze and /api/iv, supervises the Python
//! services — market data over stdio (`market`, /api/market/*) and HTTP modules such as
//! the journal (`service` + `proxy`, /journal and /api/journal) — and refuses foreign
//! hosts and cross-site writes for all of it (`security`).
//!
//! Pricing and Greeks come from OptionStratLib:
//!   * European (Black-Scholes-Merton): `pricing::black_scholes` + `Greeks` trait (incl. 2nd order)
//!   * Futures options (Black-76):      `pricing::black_76` + `greeks::*_b76`
//!   * American (Barone-Adesi-Whaley):  `pricing::barone_adesi_whaley`, Greeks by finite differences
//!
//! Run with `cargo run --release`, then open http://127.0.0.1:3000

mod assets;
mod broker;
mod market;
mod proxy;
mod security;
mod service;
mod supervisor;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use engine::{AnalyseRequest, IvRequest};
use service::{Service, ServiceConfig, Upstream};
use std::sync::Arc;

/// Private port the journal service listens on (JOURNAL_PORT overrides).
const JOURNAL_PORT: u16 = 3101;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let app = Router::new()
        .merge(assets::router())
        .route("/api/analyze", post(analyse))
        .route("/api/iv", post(solve_iv));

    let addr = format!("127.0.0.1:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Could not bind {addr}: {e}\nTry another port, e.g.  PORT=3001 cargo run --release");
            std::process::exit(1);
        }
    };
    // Started only after the bind succeeds, so a busy port never leaves a sidecar connected
    // to TWS. A failed spawn only marks the sidecar offline; the HTTP app keeps working.
    let sidecar = market::Sidecar::spawn(market::SidecarConfig::from_env());
    let journal = Service::spawn(journal_config(port));
    let journal_upstream: Arc<dyn Upstream> = Arc::clone(&journal) as Arc<dyn Upstream>;
    // The routes share the services through their state, which keeps them alive while serving.
    let app = app
        .merge(market::router(Arc::clone(&sidecar)))
        .merge(broker::router(Arc::clone(&sidecar)))
        .merge(proxy::router(journal_upstream, &["/journal", "/api/journal"]))
        .layer(axum::middleware::from_fn(security::local_only));
    println!("
  OptionDash running →  http://{addr}
  (Ctrl+C to stop)
");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
    // Dropping the supervisors kills their children.
    drop(journal);
    drop(sidecar);
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    println!("
  Shutting down…");
}

/// `python modules/journal/run.py` on a private localhost port, data under data/journal.
fn journal_config(gateway_port: u16) -> ServiceConfig {
    let root = env!("CARGO_MANIFEST_DIR");
    let port = std::env::var("JOURNAL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(JOURNAL_PORT);
    let data = std::env::var("JOURNAL_DATA").unwrap_or_else(|_| format!("{root}/data/journal"));
    ServiceConfig {
        name: "journal",
        program: crate::supervisor::python_program(),
        script: format!("{root}/modules/journal/run.py").into(),
        args: Vec::new(),
        env: vec![
            ("TRADELOG_PORT".into(), port.to_string()),
            ("TRADELOG_DATA".into(), data),
            ("PYTHONUNBUFFERED".into(), "1".into()),
            // the journal exits when our stdin pipe closes, so it never outlives the gateway
            ("JOURNAL_PARENT_WATCH".into(), "1".into()),
            // the journal reads fills from the one shared TWS session, through us
            ("BROKER_URL".into(), format!("http://127.0.0.1:{gateway_port}/api/broker")),
        ],
        port,
        backoff: supervisor::Backoff::default(),
    }
}

async fn analyse(Json(req): Json<AnalyseRequest>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || engine::analyse(&req)).await {
        Ok(Ok(resp)) => (StatusCode::OK, Json(serde_json::to_value(resp).unwrap())).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e.to_string()),
    }
}

async fn solve_iv(Json(req): Json<IvRequest>) -> impl IntoResponse {
    match engine::solve_iv(&req) {
        Ok(iv) => (StatusCode::OK, Json(serde_json::json!({ "iv": iv }))).into_response(),
        Err(e) => err(e),
    }
}

fn err(msg: String) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "error": msg }).to_string(),
    )
        .into_response()
}
