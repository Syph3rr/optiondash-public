# Journal (OptionDash module)

A journal for structured options trades: verticals, condors, butterflies, calendars, strangles, rolls and custom combos. You log trades in the browser and everything is saved to one SQLite file on your machine. Each trade has its own page with P&L, heatmap and Greeks charts priced by the OptionDash engine (American/BAW), plus a P&L timeline; analytics across all trades are on OptionDash's Home page. You can optionally import fills from IBKR's TWS.

## Run it

**The supported way is through the OptionDash gateway.** From the repo root:

```bash
cargo run
```

Then open **http://127.0.0.1:3000/journal/**. The gateway starts this service on its own localhost port and proxies `/journal/*` and `/api/journal/*` to it unchanged. It also serves what the journal pages rely on:

- `/shared/theme.css` and `/shared/nav.js`: the shared look and the platform nav bar
- `/shared/vendor/plotly.min.js`: charts (bundled, works offline)
- `POST /api/analyze`: the pricing engine behind the trade page charts

| Page | URL |
|---|---|
| Trades | `/journal/` |
| New trade | a panel on the Trades page, opened by **+ New trade** or `/journal/?new=1` (`&from=analyser` fills it from the analyser's "Log as trade"). `/journal/new` redirects there. |
| One trade | `/journal/trade?id=N` ("Open in Options Analyser" links to `/?journal_trade=N`) |
| Analytics | cards on OptionDash's Home page (`/home`); `/journal/dashboard` redirects there. The charts live in `static/js/dashboard.js`. |
| IBKR import | a panel on the Trades page (**Import from IBKR**, or `/journal/?import=1`). `/journal/ibkr` redirects there. Connect and Disconnect are in Settings and on the nav's TWS chip. |

**Standalone** (`python run.py`, port from `TRADELOG_PORT`, default 8000) still serves the API and the pages, which is what the tests use. Without the gateway there is no shared theme, nav, Plotly or pricing engine, so the pages are unstyled and the trade charts say the engine isn't available.

**Started by the gateway.** The gateway runs `python modules/journal/run.py` with `TRADELOG_PORT`, `TRADELOG_DATA` and `JOURNAL_PARENT_WATCH=1`, and keeps the child's stdin open as a pipe. With `JOURNAL_PARENT_WATCH=1` the service shuts down cleanly when stdin reaches end-of-file, i.e. when the gateway has gone. Run from a terminal without that variable, it ignores stdin.

**Other websites can't reach it.** The service only answers to the host names `127.0.0.1` and `localhost`, which blocks DNS-rebinding tricks. It also refuses any write (POST, PATCH, DELETE) that a browser marks as coming from another site, by `Origin` or `Sec-Fetch-Site`. Writes from `http://localhost` or `http://127.0.0.1` on any port are allowed, so the gateway in front of it keeps working. To accept another host name, set `TRADELOG_ALLOWED_HOSTS` (comma-separated).

The first time, install the libraries:

```bash
pip install -r requirements.txt
```

## Your data

| What | Where |
|---|---|
| Database | `trades.db` (SQLite: open it with any SQLite tool, pandas or Excel) |
| Screenshots | `screenshots/` (the database stores only the file name) |
| Backups | `backups/`, written on every start; the newest 20 are kept |

These live in the folder named by `TRADELOG_DATA`. The gateway sets it to `data/journal` at the repo root; standalone it defaults to `modules/journal/data`. Both are git-ignored.

**Export:** `/api/journal/export.csv` gives one row per trade. `/api/journal/export.json` gives everything: trades, legs, fills, marks and tags.

## How trades are modelled

- A **trade** is one idea or campaign: the underlying, the strategy and your journal. The journal holds setup, thesis, planned exit, target and stop, confidence from 1 to 5, the review, lessons, and tags for emotions, mistakes and anything else.
- A **leg** is one contract: call, put or stock, with its strike, expiry and multiplier (100 for options by default).
- An **execution** is one fill on a leg. Quantity is `+` for bought and `-` for sold. Price is per share. Each fill has an event: `open`, `adjust`, `roll`, `close`, `expire` or `assign`.
  - Time is a date (`2026-11-05`) or a date and time (`2026-11-05T10:15:00`, New York time). Fills are ordered by day, then by the order they were entered, so a date-only manual fill and timed IBKR fills on the same day stay in sequence.
  - Backfilling: the New trade form's **Later closes & adjustments** section logs later fills (each block one dated event, e.g. sell 4 on 8 Oct, sell 6 on 15 Oct) with the trade. They go in `events` on `POST /api/journal/trades`, describe legs in full (no `leg_id`), can't be dated before `opened_at`, and are written oldest first in the same transaction, so an over-close refuses the whole trade. On the trade page, **Save & add another** in Adjust / Roll / Close reopens the dialog with what is still open.
  - `close`, `expire` and `assign` can only shrink what is open on a leg. Closing 3 when 1 is open, or "closing" in the same direction as the position, is refused. Use `adjust` or `roll` to add to a position or flip it.
- **P&L is always computed from executions, never typed in.** It uses average cost per leg, and commissions are included.
  - A trade is **closed** when every leg is back to zero.
  - Realised P&L is the net cash flow over all fills.
- **Rolls stay in the same trade.** A roll is a single `roll` event that closes the old legs and opens the new ones. The trade's P&L is then the whole campaign. The *initial* structure (fills marked `open`) is kept, so max risk and return on risk stay measured against what you first put on.
- **Marks** are optional. A mark records the position's value on a date (what it would cost or pay to close now), which gives open trades an unrealised P&L and adds points to the timeline.
  - `unrealized_pnl` is the **total** P&L of an open trade: cash so far, including any partial closes, plus the latest mark.
  - A mark dated before the trade's latest fill describes a position that no longer exists. It is then ignored: `unrealized_pnl` is empty and `mark_stale` is `true`. Add a new mark after an adjustment or roll.
- **Stats:** a trade closed at exactly $0 counts as a *scratch*. It counts toward the trade total and win rate, but not toward the average loss. Open risk lists positions with unlimited loss (and no max-risk override) separately, as `unlimited`, rather than counting them as $0.
- **Max profit, max loss and breakevens** in the trade views and stats are measured at the first expiry by `app/pricing.py`. At expiry that is intrinsic value, so it matches the engine exactly.
  - Legs that expire later (calendars, diagonals) are valued with a minimal Black-Scholes at the IV you entered (or 30% if you didn't). It is only used for these bounds.
  - When the risk can't be bounded, for example a naked short call, set **max risk** by hand so return on risk can still be computed.
- **Charts are priced by the gateway's engine** (`POST /api/analyze`, American/BAW with Greeks), the same engine as the analyser. The trade page builds the request in `static/js/engine.js`:
  - the position is the current one (net quantity at average cost) or, with "As opened", the opening fills;
  - time runs from 09:30 New York on the day the trade was opened, and options settle at 16:00 New York on expiry day;
  - IV is the trade's entry IV unless you type another (30% if neither), spot is the entry price unless you type another, and the rate is 4%.

## IBKR (TWS)

The journal no longer has its own TWS connection. OptionDash owns **one shared, read-only TWS connection** (the broker, in `services/market`), and the analyser's market data and the journal's fill import both use it through the gateway's `/api/broker/*`. The **TWS** chip in the nav (bottom of the sidebar; top bar on narrow screens) and the Interactive Brokers card in Settings show the same state.

It places no orders, and it **only connects when you press Connect**, on the TWS chip, in Settings, or in the import panel. There is no connection at start-up and no background retrying. Each press makes one attempt.

1. In TWS: **Global Configuration → API → Settings**
   - Tick **Enable ActiveX and Socket Clients**.
   - Set **Socket port** to `7496` (or set `IBKR_PORT` for the gateway; see the root README).
   - Ticking **Read-Only API** is fine too.
2. Press **Connect**, then on the **IBKR** page press **Sync fills**. The journal asks the broker for `GET /api/broker/executions`; if TWS isn't connected the page says so.
3. Synced fills wait in a review queue, grouped by order, so a combo order's legs arrive together. For each group you can:
   - **create a new trade** from it (the group says which account it goes to: the IBKR account whose broker ref is the fills' account number, else the first IBKR account; set broker refs in Settings → Accounts),
   - **add it to an existing trade**, saying whether it opens, adjusts, rolls, closes, expires or is an assignment (required), or
   - **ignore it**.

   Fills already imported are skipped. If you delete a trade or an execution, its fills go back to the queue.

   Commission reports arrive just after the fills. A fill whose commission IBKR hasn't reported yet shows **commission pending** in the queue and is stored as $0. The next sync fills it in, even if you have already assigned the fill: the trade's execution is corrected too, unless you edited that commission by hand. A commission IBKR has reported is never overwritten. Assigning a fill with a pending commission is allowed; the page just reminds you to sync again.

   Rebates (negative commissions) are stored as $0: journal commissions are costs.

   A sync reports **new**, **updated** (commissions filled in) and **unchanged** fills; the three always add up to the number received.

**Limitation:** TWS only reports executions from the current session. If you raise **Trade Log → "Show trades for"** in TWS, it reports up to 7 days. Sync at least weekly, or log older trades by hand.

| Environment variable | Default | Purpose |
|---|---|---|
| `BROKER_URL` | `http://127.0.0.1:3000/api/broker` | The gateway's broker API (the gateway sets this when it starts the journal) |
| `TRADELOG_RATE` | `0.04` | Risk-free rate for the expiry bounds of multi-expiry structures |

TWS host, port and client id are the gateway's settings now (`IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID`). Fill times arrive in New York time. A sync gives up after 30 seconds if the broker doesn't answer. Sync errors keep the broker's own message: 409 not connected, 503 broker unavailable, 504 timed out, 502 anything else.

The database is schema v3 (v2 added `ibkr_fills.commission_known`, v3 the `analyses` table of saved analyser set-ups). An older journal database is upgraded in place when the journal starts, after the usual start-up backup. Run standalone (without the gateway), the import panel shows that the shared connection is unavailable; everything else works.

## Tests

```bash
python -m pytest -q --cov=app       # backend; never touches TWS or your real data
node --test "tests/frontend/*.test.cjs"   # pure frontend helpers
```

## Layout

```
run.py                 start the service on 127.0.0.1 (the gateway runs this)
app/parentwatch.py     exit when the gateway's stdin pipe closes (JOURNAL_PARENT_WATCH=1)
app/main.py            app factory, error handling, page routes, static mounts
app/config.py          settings (env overrides)
app/security.py        local-only guard: Host check, cross-site write refusal
app/db.py, schema.sql  SQLite connection, schema versioning, start-up backups
app/models.py          request validation (pydantic)
app/repo.py            all SQL (parameterised)
app/analyses.py        saved analyser set-ups: validation and SQL
app/ledger.py          fills -> positions and P&L (average cost)
app/pricing.py         expiry bounds for stats: max profit/loss, breakevens
app/views.py           computed trade view: status, P&L, risk, timeline
app/stats.py           portfolio analytics (equity, drawdown, breakdowns)
app/routes/            HTTP endpoints: trades, files (screenshots/export), stats, ibkr, analyses
app/ibkr/              broker client (fills via the gateway) and the fill review queue
static/                pages, CSS and JS (theme, nav and Plotly come from /shared)
static/js/engine.js    trade -> /api/analyze request (pure, tested)
static/js/prefill.js   analyser "Log as trade" hand-off (pure, tested)
static/js/accountpick.js  default account, account for fills, bulk-move undo plan (pure, tested)
static/js/bulkmove.js  the Trades page's "N selected · Move to" bar and its Undo
tests/                 pytest suite; tests/frontend/ for node tests
```

## API

Every response is `{"ok": bool, "data": ..., "error": str | null}`. All paths are under `/api/journal`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/journal/meta` | strategies and existing tags |
| GET/POST | `/api/journal/trades` | list (with computed fields) / create a trade with its opening fills |
| GET/PATCH/DELETE | `/api/journal/trades/{id}` | one trade / edit header and journal / delete |
| POST | `/api/journal/trades/{id}/events` | add fills (adjust, roll, close, expire, assign) |
| PATCH/DELETE | `/api/journal/executions/{id}` | fix or remove a fill |
| POST | `/api/journal/trades/{id}/marks`, DELETE `/api/journal/marks/{id}` | marks |
| GET/POST | `/api/journal/analyses` | saved analyser set-ups: list (id, name, underlying, updated_at) / save `{name, state}` (name 1–80 characters, state a JSON object up to 200 KB) |
| GET/PUT/DELETE | `/api/journal/analyses/{id}` | one saved set-up with its state / change `{name?, state?}` / delete |
| POST | `/api/journal/trades/{id}/screenshots`, DELETE `/api/journal/screenshots/{id}` | screenshots (PNG, JPEG, GIF or WebP, up to 10 MB), served at `/journal/screenshots/<file>` |
| GET | `/api/journal/stats` | portfolio analytics |
| GET | `/api/journal/export.csv`, `/api/journal/export.json` | export |
| GET | `/api/journal/ibkr/info`, `/api/journal/ibkr/pending?status=` | last sync and review queue |
| POST | `/api/journal/ibkr/sync`, `/assign`, `/ignore` | pull fills from the broker; file or ignore them |

Connect, disconnect and status are the gateway's `/api/broker/*`, not the journal's.

The trade view's `legs[].kind/strike/expiry/net_qty/avg_cost/multiplier`, `underlying`, `iv_entry` and `underlying_entry` are what the analyser reads for "Open in Options Analyser"; keep them stable.
