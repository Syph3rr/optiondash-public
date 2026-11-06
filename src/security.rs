//! Keep the platform local: refuse foreign Host headers and cross-site writes.
//!
//! The gateway only listens on 127.0.0.1, but a web page in the same browser can still
//! reach it, through DNS rebinding (a foreign name resolving to 127.0.0.1) or a plain
//! cross-site POST, which needs no CORS preflight. So, for every request:
//!
//! * the Host header must name 127.0.0.1 or localhost (any port), else 400;
//! * POST/PUT/PATCH/DELETE are refused (403) when the browser marks them cross-site:
//!   an `Origin` that is not http on an allowed host (any port; `null` counts as foreign)
//!   or `Sec-Fetch-Site: cross-site`.
//!
//! Requests without those browser headers (curl, scripts) pass. Same rules as the
//! journal's own `modules/journal/app/security.py`.

use axum::{
    extract::Request,
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub const ALLOWED_HOSTS: [&str; 2] = ["127.0.0.1", "localhost"];

/// Host name without its port, lower-cased; `[::1]:3000` → `::1`.
fn host_name(host: &str) -> String {
    let host = host.trim().to_ascii_lowercase();
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or_default().to_string();
    }
    match host.matches(':').count() {
        1 => host.split(':').next().unwrap_or_default().to_string(),
        _ => host,
    }
}

fn is_allowed(name: &str) -> bool {
    ALLOWED_HOSTS.contains(&name)
}

fn origin_is_local(origin: &str) -> bool {
    let Some(rest) = origin.trim().strip_prefix("http://") else {
        return false; // https, null, file://, ...
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false; // userinfo has no place in an Origin
    }
    is_allowed(&host_name(authority))
}

fn is_unsafe(method: &Method) -> bool {
    matches!(*method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE)
}

/// `None` if the request may go through, else the status and message to refuse it with.
pub fn check(
    method: &Method,
    host: Option<&str>,
    origin: Option<&str>,
    fetch_site: Option<&str>,
) -> Option<(StatusCode, &'static str)> {
    if !host.is_some_and(|h| is_allowed(&host_name(h))) {
        return Some((StatusCode::BAD_REQUEST, "unknown host; open the app at http://127.0.0.1"));
    }
    if !is_unsafe(method) {
        return None;
    }
    let cross_origin = origin.is_some_and(|o| !origin_is_local(o));
    let cross_site = fetch_site.is_some_and(|s| s.trim().eq_ignore_ascii_case("cross-site"));
    if cross_origin || cross_site {
        return Some((StatusCode::FORBIDDEN, "cross-site requests are not allowed"));
    }
    None
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Middleware applying `check` to every request the gateway receives.
pub async fn local_only(req: Request, next: Next) -> Response {
    let headers = req.headers();
    // HTTP/1.1 sends Host; HTTP/2 carries it in the URI authority instead.
    let host = header_str(headers, header::HOST.as_str())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()));
    let refused = check(
        req.method(),
        host.as_deref(),
        header_str(headers, header::ORIGIN.as_str()),
        header_str(headers, "sec-fetch-site"),
    );
    match refused {
        None => next.run(req).await,
        Some((status, message)) => (
            status,
            [(header::CONTENT_TYPE, "application/json")],
            // Both envelopes in use read `error`: the journal's {ok, data, error} and
            // the analyser's {error}.
            serde_json::json!({ "ok": false, "data": null, "error": message }).to_string(),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, routing::any};
    use tower::ServiceExt;

    const LOCAL: Option<&str> = Some("127.0.0.1:3000");

    #[test]
    fn host_must_be_local_with_any_port() {
        for ok in ["127.0.0.1", "127.0.0.1:3000", "localhost:8080", "LOCALHOST"] {
            assert_eq!(check(&Method::GET, Some(ok), None, None), None, "{ok}");
        }
        for bad in ["evil.example", "evil.example:3000", "127.0.0.1.evil.example", "[::1]:3000", ""] {
            let r = check(&Method::GET, Some(bad), None, None);
            assert_eq!(r.map(|r| r.0), Some(StatusCode::BAD_REQUEST), "{bad}");
        }
        assert_eq!(check(&Method::GET, None, None, None).map(|r| r.0), Some(StatusCode::BAD_REQUEST));
    }

    #[test]
    fn reads_are_never_refused_for_their_origin() {
        assert_eq!(check(&Method::GET, LOCAL, Some("https://evil.example"), Some("cross-site")), None);
    }

    #[test]
    fn writes_from_local_origins_or_without_browser_headers_pass() {
        for m in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
            assert_eq!(check(&m, LOCAL, None, None), None);
            assert_eq!(check(&m, LOCAL, Some("http://127.0.0.1:3000"), Some("same-origin")), None);
            assert_eq!(check(&m, LOCAL, Some("http://localhost:3101"), None), None);
        }
    }

    #[test]
    fn cross_site_writes_are_refused() {
        let bad_origins = [
            "https://evil.example",
            "http://evil.example",
            "null",
            "https://127.0.0.1:3000",
            "http://127.0.0.1.evil.example",
            "http://user@127.0.0.1:3000",
            "file://",
        ];
        for o in bad_origins {
            let r = check(&Method::POST, LOCAL, Some(o), None);
            assert_eq!(r.map(|r| r.0), Some(StatusCode::FORBIDDEN), "{o}");
        }
        let r = check(&Method::DELETE, LOCAL, None, Some("Cross-Site"));
        assert_eq!(r.map(|r| r.0), Some(StatusCode::FORBIDDEN));
    }

    fn app() -> Router {
        Router::new()
            .route("/x", any(|| async { "ok" }))
            .layer(axum::middleware::from_fn(local_only))
    }

    async fn send(method: Method, host: &str, origin: Option<&str>) -> StatusCode {
        let mut req = Request::builder().method(method).uri("/x").header("host", host);
        if let Some(o) = origin {
            req = req.header("origin", o);
        }
        app().oneshot(req.body(Body::empty()).unwrap()).await.unwrap().status()
    }

    #[tokio::test]
    async fn middleware_applies_the_rules() {
        assert_eq!(send(Method::GET, "127.0.0.1:3000", None).await, StatusCode::OK);
        assert_eq!(send(Method::GET, "evil.example", None).await, StatusCode::BAD_REQUEST);
        assert_eq!(
            send(Method::POST, "127.0.0.1:3000", Some("https://evil.example")).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send(Method::POST, "127.0.0.1:3000", Some("http://127.0.0.1:3000")).await,
            StatusCode::OK
        );
    }
}
