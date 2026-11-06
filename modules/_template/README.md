# Module template

Copy this folder to `modules/<name>/` to start a new section of OptionDash. `_template` itself is
never built or served. Portfolio (`modules/portfolio/`) is a finished example of this shape.

Replace `NAME` (lower case, one word) and `Title` in every file you copy.

## A. Static-page module (no backend of its own)

Use this when the page only needs the gateway's existing APIs (`/api/broker/*`, `/api/market/*`,
`/api/analyze`, `/api/journal/*`).

1. Copy `web/index.html`, `web/page.js`, `web/NAME.css` and `web/NAME.js` into `modules/NAME/web/`
   (rename the placeholders). Keep the pure logic in `NAME.js` so Node tests can load it.
2. **`src/assets.rs`:** add `NAME_INDEX` and a `NAME: &[Asset]` table next to `PORTFOLIO`, add the
   `/NAME` and `/NAME/static/{*path}` routes to `router()`, add the prefix to `resolves()` in the tests,
   and add `NAME` to `asset_paths_are_unique`. Copy the `every_asset_the_portfolio_page_loads_is_embedded`
   test.
3. **`web/shared/nav.js`:** add one entry to `MODULES` with its sidebar group (Overview, Analysis, Journal, or Settings, which is `pinned` to the bottom); set `soon: true` while it is a stub.
4. **Tests:** `tests/frontend/NAME.test.cjs` for the pure helpers (write it first). Run
   `cargo test --release --workspace` and `node --test "tests/frontend/*.test.cjs"`.
5. **README:** add the URL to the URLs table and tick or add the item in the Roadmap.
6. **Home card (optional):** write `web/widgets.js` that calls `ODWidgets.register({id, title, size, order, link, mount})`
   (see `web/shared/widgets.js` and `modules/portfolio/web/widgets.js`), add it to the `NAME` asset table, and list its
   URL in `WIDGET_SCRIPTS` in `modules/home/web/page.js`. A test checks every listed script is served.

## B. Module with its own Python server

Do A first for the sidebar entry, then model the backend on `modules/journal/`: a FastAPI app factory
(`app/main.py`), routes, a repo over SQLite, `run.py` and tests.

1. **`src/main.rs`:** add a `NAME_config()` like `journal_config` (program, script, a private port,
   env), a `Service::spawn`, and `proxy::router(upstream, &["/NAME", "/api/NAME"])` before the
   `security::local_only` layer.
2. The module exits with the gateway if it reads stdin through `parentwatch` (copy the journal's).
3. Serve the module's pages from its own `static/` folder; no Rust rebuild is needed for page changes.
4. Tests: `python -m pytest modules/NAME/tests -q`.

## Rules every module follows

- Dark theme from `/shared/theme.css`; link `/shared/nav.js` in `<head>` for the sidebar and TWS chip.
- Server text goes in with `textContent`, never `innerHTML`.
- Never poll or connect to TWS on your own. Read on load, on a Refresh button and on the
  `broker:changed` window event.
- No new data source without a README roadmap entry saying where the data comes from.
