//! Embedded web assets. Every file is compiled into the binary, so the platform works
//! offline and ships as one executable.
//!
//! URL scheme:
//!   /                     analyser page
//!   /analyser/<file>      analyser scripts        (modules/analyser/web/)
//!   /shared/<path>        assets for every module (web/shared/)
//!
//! To add a module's files, give it a table like `ANALYSER` and a route in `router`.

use axum::{
    Router,
    extract::Path,
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};

pub struct Asset {
    pub path: &'static str,
    pub mime: &'static str,
    pub body: &'static str,
}

const JS: &str = "application/javascript";
const CSS: &str = "text/css";
/// Vendored libraries never change between builds, so browsers may keep them a day.
const VENDOR_CACHE: &str = "max-age=86400";

macro_rules! asset {
    ($path:literal, $mime:expr, $file:literal) => {
        Asset { path: $path, mime: $mime, body: include_str!($file) }
    };
}

pub const ANALYSER_INDEX: &str = include_str!("../modules/analyser/web/index.html");

/// Served at /analyser/<path>.
pub static ANALYSER: &[Asset] = &[
    asset!("controls.js", JS, "../modules/analyser/web/controls.js"),
    asset!("legrules.js", JS, "../modules/analyser/web/legrules.js"),
    asset!("presets.js", JS, "../modules/analyser/web/presets.js"),
    asset!("syncplan.js", JS, "../modules/analyser/web/syncplan.js"),
    asset!("forwardiv.js", JS, "../modules/analyser/web/forwardiv.js"),
    asset!("market.js", JS, "../modules/analyser/web/market.js"),
    asset!("earnings.js", JS, "../modules/analyser/web/earnings.js"),
    asset!("earnpanel.js", JS, "../modules/analyser/web/earnpanel.js"),
    asset!("greekframes.js", JS, "../modules/analyser/web/greekframes.js"),
    asset!("greekplay.js", JS, "../modules/analyser/web/greekplay.js"),
    asset!("journallink.js", JS, "../modules/analyser/web/journallink.js"),
    asset!("journalui.js", JS, "../modules/analyser/web/journalui.js"),
    asset!("savedanalyses.js", JS, "../modules/analyser/web/savedanalyses.js"),
    asset!("savedui.js", JS, "../modules/analyser/web/savedui.js"),
    asset!("position.js", JS, "../modules/analyser/web/position.js"),
    asset!("positionui.js", JS, "../modules/analyser/web/positionui.js"),
    asset!("tvpanel.js", JS, "../modules/analyser/web/tvpanel.js"),
];

/// The Portfolio page at /portfolio; its files are served at /portfolio/static/<path>.
pub const PORTFOLIO_INDEX: &str = include_str!("../modules/portfolio/web/index.html");
pub static PORTFOLIO: &[Asset] = &[
    asset!("portfolio.js", JS, "../modules/portfolio/web/portfolio.js"),
    asset!("page.js", JS, "../modules/portfolio/web/page.js"),
    asset!("grouping.js", JS, "../modules/portfolio/web/grouping.js"),
    asset!("cardview.js", JS, "../modules/portfolio/web/cardview.js"),
    asset!("sections.js", JS, "../modules/portfolio/web/sections.js"),
    asset!("greeks.js", JS, "../modules/portfolio/web/greeks.js"),
    asset!("drawer.js", JS, "../modules/portfolio/web/drawer.js"),
    asset!("widgets.js", JS, "../modules/portfolio/web/widgets.js"),
    asset!("portfolio.css", CSS, "../modules/portfolio/web/portfolio.css"),
];

/// The Home page at /home; its files are served at /home/static/<path>.
pub const HOME_INDEX: &str = include_str!("../modules/home/web/index.html");
pub static HOME: &[Asset] = &[
    asset!("page.js", JS, "../modules/home/web/page.js"),
    asset!("widgets.js", JS, "../modules/home/web/widgets.js"),
    asset!("home.css", CSS, "../modules/home/web/home.css"),
];

/// The Chain & screener page at /chain; its files are served at /chain/static/<path>.
pub const CHAIN_INDEX: &str = include_str!("../modules/chain/web/index.html");
pub static CHAIN: &[Asset] = &[
    asset!("chain.js", JS, "../modules/chain/web/chain.js"),
    asset!("page.js", JS, "../modules/chain/web/page.js"),
    asset!("chain.css", CSS, "../modules/chain/web/chain.css"),
];

/// The Settings page at /settings; its files are served at /settings/static/<path>.
pub const SETTINGS_INDEX: &str = include_str!("../modules/settings/web/index.html");
pub static SETTINGS: &[Asset] = &[
    asset!("page.js", JS, "../modules/settings/web/page.js"),
    asset!("tws.js", JS, "../modules/settings/web/tws.js"),
    asset!("accountscard.js", JS, "../modules/settings/web/accountscard.js"),
    asset!("settings.css", CSS, "../modules/settings/web/settings.css"),
];

/// Served at /shared/<path>.
pub static SHARED: &[Asset] = &[
    asset!("vendor/plotly.min.js", JS, "../web/shared/vendor/plotly.min.js"),
    asset!("theme.css", CSS, "../web/shared/theme.css"),
    asset!("nav.js", JS, "../web/shared/nav.js"),
    asset!("widgets.js", JS, "../web/shared/widgets.js"),
    asset!("tvchart.js", JS, "../web/shared/tvchart.js"),
    asset!("accounts.js", JS, "../web/shared/accounts.js"),
    asset!("vendor/sortable.min.js", JS, "../web/shared/vendor/sortable.min.js"),
];

/// Binary shared assets (fonts), served at /shared/<path>. Fonts never change between builds.
pub static FONTS: &[(&str, &[u8])] = &[
    ("fonts/inter.woff2", include_bytes!("../web/shared/fonts/inter.woff2")),
    ("fonts/jetbrains-mono.woff2", include_bytes!("../web/shared/fonts/jetbrains-mono.woff2")),
];

fn serve_shared(path: &str) -> Response {
    if let Some((_, body)) = FONTS.iter().find(|(p, _)| *p == path) {
        return (
            [(header::CONTENT_TYPE, "font/woff2"), (header::CACHE_CONTROL, VENDOR_CACHE)],
            *body,
        )
            .into_response();
    }
    serve(SHARED, path)
}

pub fn router() -> Router {
    Router::new()
        .route("/", get(|| async { Html(ANALYSER_INDEX) }))
        .route("/analyser/{*path}", get(|Path(p): Path<String>| async move { serve(ANALYSER, &p) }))
        // The old US spelling of the asset path, kept so anything still pointing at it works.
        .route("/analyzer/{*path}", get(|Path(p): Path<String>| async move { serve(ANALYSER, &p) }))
        .route("/shared/{*path}", get(|Path(p): Path<String>| async move { serve_shared(&p) }))
        .route("/settings", get(|| async { Html(SETTINGS_INDEX) }))
        .route("/settings/", get(|| async { Html(SETTINGS_INDEX) }))
        .route(
            "/settings/static/{*path}",
            get(|Path(p): Path<String>| async move { serve(SETTINGS, &p) }),
        )
        .route("/home", get(|| async { Html(HOME_INDEX) }))
        .route("/home/", get(|| async { Html(HOME_INDEX) }))
        .route(
            "/home/static/{*path}",
            get(|Path(p): Path<String>| async move { serve(HOME, &p) }),
        )
        .route("/chain", get(|| async { Html(CHAIN_INDEX) }))
        .route("/chain/", get(|| async { Html(CHAIN_INDEX) }))
        .route(
            "/chain/static/{*path}",
            get(|Path(p): Path<String>| async move { serve(CHAIN, &p) }),
        )
        .route("/portfolio", get(|| async { Html(PORTFOLIO_INDEX) }))
        .route("/portfolio/", get(|| async { Html(PORTFOLIO_INDEX) }))
        .route(
            "/portfolio/static/{*path}",
            get(|Path(p): Path<String>| async move { serve(PORTFOLIO, &p) }),
        )
}

fn serve(table: &[Asset], path: &str) -> Response {
    let Some(asset) = table.iter().find(|a| a.path == path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if asset.path.starts_with("vendor/") {
        ([(header::CONTENT_TYPE, asset.mime), (header::CACHE_CONTROL, VENDOR_CACHE)], asset.body)
            .into_response()
    } else {
        ([(header::CONTENT_TYPE, asset.mime)], asset.body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `src="/…"` / `href="/…"` in a page, minus links to other pages.
    fn referenced(html: &str) -> Vec<String> {
        let mut out = Vec::new();
        for attr in ["src=\"/", "href=\"/"] {
            let mut rest = html;
            while let Some(i) = rest.find(attr) {
                rest = &rest[i + attr.len() - 1..];
                let end = rest.find('"').unwrap_or(rest.len());
                out.push(rest[..end].to_string());
                rest = &rest[end..];
            }
        }
        out
    }

    fn resolves(url: &str) -> bool {
        if let Some(p) = url.strip_prefix("/analyser/") {
            return ANALYSER.iter().any(|a| a.path == p);
        }
        if let Some(p) = url.strip_prefix("/settings/static/") {
            return SETTINGS.iter().any(|a| a.path == p);
        }
        if let Some(p) = url.strip_prefix("/home/static/") {
            return HOME.iter().any(|a| a.path == p);
        }
        if let Some(p) = url.strip_prefix("/chain/static/") {
            return CHAIN.iter().any(|a| a.path == p);
        }
        if let Some(p) = url.strip_prefix("/portfolio/static/") {
            return PORTFOLIO.iter().any(|a| a.path == p);
        }
        if let Some(p) = url.strip_prefix("/shared/") {
            return SHARED.iter().any(|a| a.path == p) || FONTS.iter().any(|(f, _)| *f == p);
        }
        false
    }

    #[test]
    fn every_asset_the_analyser_page_loads_is_embedded() {
        let urls = referenced(ANALYSER_INDEX);
        assert!(!urls.is_empty(), "index.html references no assets?");
        for url in urls {
            assert!(resolves(&url), "index.html loads {url}, which the gateway does not serve");
        }
    }

    #[test]
    fn saved_analyses_and_position_scripts_are_served_as_js() {
        for path in ["savedanalyses.js", "savedui.js", "position.js", "positionui.js"] {
            let resp = serve(ANALYSER, path);
            assert_eq!(resp.status(), StatusCode::OK, "{path}");
            assert_eq!(resp.headers()[header::CONTENT_TYPE], JS, "{path}");
        }
    }

    /// Shared scripts that pages pick up by URL.
    #[test]
    fn shared_scripts_are_served_as_js() {
        for path in ["nav.js", "widgets.js", "tvchart.js", "accounts.js"] {
            let resp = serve_shared(path);
            assert_eq!(resp.status(), StatusCode::OK, "{path}");
            assert_eq!(resp.headers()[header::CONTENT_TYPE], JS, "{path}");
        }
    }

    #[test]
    fn every_asset_the_portfolio_page_loads_is_embedded() {
        let urls = referenced(PORTFOLIO_INDEX);
        assert!(!urls.is_empty(), "portfolio page references no assets?");
        for url in urls {
            assert!(resolves(&url), "portfolio page loads {url}, which the gateway does not serve");
        }
    }

    #[test]
    fn every_asset_the_chain_page_loads_is_embedded() {
        let urls = referenced(CHAIN_INDEX);
        assert!(!urls.is_empty(), "chain page references no assets?");
        for url in urls {
            assert!(resolves(&url), "chain page loads {url}, which the gateway does not serve");
        }
    }

    #[test]
    fn every_asset_the_home_page_loads_is_embedded() {
        let urls = referenced(HOME_INDEX);
        assert!(!urls.is_empty(), "home page references no assets?");
        for url in urls {
            assert!(resolves(&url), "home page loads {url}, which the gateway does not serve");
        }
    }

    /// Home loads these by script tag from page.js, so the HTML check above cannot see them.
    #[test]
    fn every_widget_script_home_loads_is_embedded_or_proxied() {
        let page = include_str!("../modules/home/web/page.js");
        let mut checked = 0;
        for line in page.lines().filter(|l| l.trim_start().starts_with("'/")) {
            let url = line.trim().trim_end_matches(',').trim_matches('\'');
            if url.starts_with("/journal/") {
                continue; // served by the journal service, not embedded
            }
            assert!(resolves(url), "home loads {url}, which the gateway does not serve");
            checked += 1;
        }
        assert!(checked >= 3, "expected to check the embedded widget scripts, got {checked}");
    }

    #[test]
    fn every_asset_the_settings_page_loads_is_embedded() {
        let urls = referenced(SETTINGS_INDEX);
        assert!(!urls.is_empty(), "settings page references no assets?");
        for url in urls {
            if url.starts_with("/journal/") {
                continue; // a link to the journal's Trades page, served by the journal
            }
            assert!(resolves(&url), "settings page loads {url}, which the gateway does not serve");
        }
    }

    #[test]
    fn asset_paths_are_unique() {
        for table in [ANALYSER, PORTFOLIO, CHAIN, HOME, SETTINGS, SHARED] {
            for (i, a) in table.iter().enumerate() {
                assert!(table[i + 1..].iter().all(|b| b.path != a.path), "duplicate {}", a.path);
            }
        }
    }

    #[test]
    fn unknown_asset_is_404() {
        assert_eq!(serve(ANALYSER, "nope.js").status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(SHARED, "../src/main.rs").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn only_vendor_files_are_cached() {
        let vendor = serve(SHARED, "vendor/plotly.min.js");
        assert_eq!(vendor.headers()[header::CACHE_CONTROL], VENDOR_CACHE);
        let app = serve(ANALYSER, "controls.js");
        assert!(app.headers().get(header::CACHE_CONTROL).is_none());
        assert_eq!(app.headers()[header::CONTENT_TYPE], JS);
    }
}
