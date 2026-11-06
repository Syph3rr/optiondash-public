//! Proxy tests against a real upstream on an ephemeral port.

use super::*;
use axum::{body::to_bytes, http::Method};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixed {
    port: u16,
    reason: Option<String>,
}

impl Upstream for Fixed {
    fn name(&self) -> &str {
        "journal"
    }
    fn port(&self) -> u16 {
        self.port
    }
    fn offline_reason(&self) -> Option<String> {
        self.reason.clone()
    }
}

/// Echoes what it received as JSON, with a custom status and header.
async fn echo(req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap();
    let headers: serde_json::Map<String, Value> = parts
        .headers
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or(""))))
        .collect();
    let out = json!({
        "method": parts.method.as_str(),
        "uri": parts.uri.to_string(),
        "headers": headers,
        "len": bytes.len(),
        "body_head": String::from_utf8_lossy(&bytes[..bytes.len().min(16)]),
    });
    (StatusCode::IM_A_TEAPOT, [("x-upstream", "yes")], axum::Json(out)).into_response()
}

async fn upstream() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new().fallback(echo);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn proxy(port: u16, reason: Option<&str>) -> Router {
    let up: Arc<dyn Upstream> = Arc::new(Fixed { port, reason: reason.map(str::to_string) });
    router(up, &["/journal", "/api/journal"])
}

async fn json_of(resp: Response) -> Value {
    serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap()
}

#[tokio::test]
async fn round_trips_method_path_query_headers_body_and_status() {
    let app = proxy(upstream().await, None);
    let req = Request::builder()
        .method(Method::PATCH)
        .uri("/api/journal/trades/7?which=current&iv=30")
        .header("host", "127.0.0.1:3000")
        .header("origin", "http://127.0.0.1:3000")
        .header("sec-fetch-site", "same-origin")
        .header("content-type", "application/json")
        .header("connection", "keep-alive, x-secret-hop")
        .header("x-secret-hop", "drop me")
        .body(Body::from(r#"{"notes":"hi"}"#))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::IM_A_TEAPOT);
    assert_eq!(resp.headers()["x-upstream"], "yes");
    let seen = json_of(resp).await;
    assert_eq!(seen["method"], "PATCH");
    assert_eq!(seen["uri"], "/api/journal/trades/7?which=current&iv=30");
    assert_eq!(seen["headers"]["host"], "127.0.0.1:3000");
    assert_eq!(seen["headers"]["origin"], "http://127.0.0.1:3000");
    assert_eq!(seen["headers"]["sec-fetch-site"], "same-origin");
    assert_eq!(seen["headers"]["content-type"], "application/json");
    assert!(seen["headers"].get("x-secret-hop").is_none(), "Connection-listed header leaked");
    assert_eq!(seen["body_head"], r#"{"notes":"hi"}"#);
}

#[tokio::test]
async fn saved_analyses_put_and_delete_reach_the_journal() {
    let port = upstream().await;
    for (method, body) in [(Method::PUT, r#"{"name":"ic"}"#), (Method::DELETE, "")] {
        let req = Request::builder()
            .method(method.clone())
            .uri("/api/journal/analyses/3")
            .header("host", "127.0.0.1:3000")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let resp = proxy(port, None).oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::IM_A_TEAPOT, "{method}");
        let seen = json_of(resp).await;
        assert_eq!(seen["method"], method.as_str());
        assert_eq!(seen["uri"], "/api/journal/analyses/3");
        assert_eq!(seen["body_head"], body);
    }
}

#[tokio::test]
async fn bare_prefix_and_trailing_slash_are_forwarded() {
    let port = upstream().await;
    for path in ["/journal", "/journal/", "/journal/static/js/api.js", "/api/journal"] {
        let req = Request::builder().uri(path).header("host", "127.0.0.1").body(Body::empty()).unwrap();
        let resp = proxy(port, None).oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::IM_A_TEAPOT, "{path}");
        assert_eq!(json_of(resp).await["uri"], path);
    }
}

#[tokio::test]
async fn other_paths_are_not_claimed() {
    let req = Request::builder().uri("/journalx").body(Body::empty()).unwrap();
    let resp = proxy(upstream().await, None).oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn large_multipart_upload_streams_through() {
    let app = proxy(upstream().await, None);
    let size = 11 * 1024 * 1024;
    let mut body = b"--b\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n".to_vec();
    body.resize(size, b'x');
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/journal/trades/1/screenshots")
        .header("content-type", "multipart/form-data; boundary=b")
        .header("content-length", size.to_string())
        .body(Body::from(body))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::IM_A_TEAPOT);
    let seen = json_of(resp).await;
    assert_eq!(seen["len"], size);
    assert!(seen["headers"]["content-type"].as_str().unwrap().starts_with("multipart/form-data"));
}

#[tokio::test]
async fn oversized_body_is_refused_up_front() {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/journal/x")
        .header("content-length", (MAX_BODY + 1).to_string())
        .body(Body::empty())
        .unwrap();
    let resp = proxy(upstream().await, None).oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn service_down_gives_503_json_for_api_with_the_reason() {
    let app = proxy(free_port(), Some("sidecar exited (exit code: 1): ImportError"));
    let req = Request::builder().uri("/api/journal/stats").body(Body::empty()).unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let v = json_of(resp).await;
    assert_eq!(v["ok"], false);
    assert!(v["error"].as_str().unwrap().contains("ImportError"), "{v}");
}

#[tokio::test]
async fn service_down_gives_a_friendly_escaped_page_for_pages() {
    let app = proxy(free_port(), Some("<b>boom</b>"));
    let req = Request::builder().uri("/journal/").body(Body::empty()).unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let html = String::from_utf8(to_bytes(resp.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
    assert!(html.contains("journal service is not running"), "{html}");
    assert!(html.contains("&lt;b&gt;boom&lt;/b&gt;") && !html.contains("<b>boom"), "{html}");
}
