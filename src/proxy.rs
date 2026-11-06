//! Reverse proxy from the gateway to a module's private HTTP service.
//!
//! Requests under a module's prefixes (for the journal: /journal and /api/journal) go to
//! http://127.0.0.1:<service port> with method, path, query, headers (Host, Origin,
//! Sec-Fetch-*, Content-Type, ...) and body unchanged, both ways streamed. Hop-by-hop
//! headers are dropped. When the service is down the caller gets a 503 saying why: JSON
//! for API paths, a small page otherwise.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, Version, header},
    response::{Html, IntoResponse, Response},
    routing::any,
};
use http_body_util::Limited;
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioExecutor;

use crate::service::Upstream;

/// Largest request body forwarded (journal screenshots are capped at 10 MB).
pub const MAX_BODY: usize = 12 * 1024 * 1024;
/// How long to wait for the service to start answering. Above the journal's broker
/// client timeout (30 s), itself above the gateway's 25 s account-read timeout, so a slow
/// IBKR sync fails with the journal's message rather than a bare proxy timeout.
pub(crate) const RESPONSE_TIMEOUT: Duration = Duration::from_secs(40);

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

#[derive(Clone)]
struct ProxyState {
    client: Client<HttpConnector, Body>,
    upstream: Arc<dyn Upstream>,
}

/// Routes every path under each prefix (and the prefix itself) to `upstream`.
pub fn router(upstream: Arc<dyn Upstream>, prefixes: &[&str]) -> Router {
    let client = Client::builder(TokioExecutor::new()).build_http();
    let state = ProxyState { client, upstream };
    prefixes
        .iter()
        .fold(Router::new(), |r, p| {
            r.route(p, any(forward))
                .route(&format!("{p}/"), any(forward))
                .route(&format!("{p}/{{*rest}}"), any(forward))
        })
        .with_state(state)
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    // Headers named in `Connection` are hop-by-hop too.
    let listed: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|n| HeaderName::from_bytes(n.trim().as_bytes()).ok())
        .collect();
    for name in listed {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    headers.get(header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

async fn forward(State(st): State<ProxyState>, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    if declared_length(&parts.headers).is_some_and(|n| n > MAX_BODY) {
        return problem(&path, StatusCode::PAYLOAD_TOO_LARGE, "request body is too large");
    }
    let pq = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    let Ok(uri) = format!("http://127.0.0.1:{}{pq}", st.upstream.port()).parse::<Uri>() else {
        return problem(&path, StatusCode::BAD_REQUEST, "bad request path");
    };
    parts.uri = uri;
    parts.version = Version::HTTP_11;
    strip_hop_by_hop(&mut parts.headers);
    let body = Body::new(Limited::new(body, MAX_BODY));

    match tokio::time::timeout(RESPONSE_TIMEOUT, st.client.request(Request::from_parts(parts, body))).await {
        Ok(Ok(resp)) => {
            let (mut parts, body) = resp.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            Response::from_parts(parts, Body::new(body))
        }
        Ok(Err(e)) if e.is_connect() => unavailable(&path, st.upstream.as_ref()),
        Ok(Err(e)) => {
            eprintln!("[proxy] {} request failed: {e:?}", st.upstream.name());
            let msg = format!("the {} service failed to answer", st.upstream.name());
            problem(&path, StatusCode::BAD_GATEWAY, &msg)
        }
        Err(_) => {
            let msg = format!("the {} service took too long to answer", st.upstream.name());
            problem(&path, StatusCode::GATEWAY_TIMEOUT, &msg)
        }
    }
}

fn unavailable(path: &str, upstream: &dyn Upstream) -> Response {
    let why = upstream
        .offline_reason()
        .unwrap_or_else(|| "it is not accepting connections".into());
    let msg = format!("The {} service is not running: {why}", upstream.name());
    problem(path, StatusCode::SERVICE_UNAVAILABLE, &msg)
}

fn problem(path: &str, status: StatusCode, message: &str) -> Response {
    if path.starts_with("/api/") {
        let body = serde_json::json!({ "ok": false, "data": null, "error": message });
        return (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], body.to_string())
            .into_response();
    }
    (status, Html(page(status, message))).into_response()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn page(status: StatusCode, message: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>Unavailable</title><link rel=\"stylesheet\" href=\"/shared/theme.css\">\
<script src=\"/shared/nav.js\"></script></head><body>\
<main style=\"max-width:720px;margin:40px auto;padding:0 18px\"><div class=\"card\" style=\"padding:18px\">\
<h2 style=\"margin-top:0\">{}</h2><p>{}</p>\
<p class=\"muted\">The analyser at <a href=\"/\">/</a> still works. The gateway restarts the \
service automatically; check the terminal running <code>cargo run</code> for details, then reload.</p>\
</div></main></body></html>",
        status.as_u16(),
        escape(message)
    )
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
