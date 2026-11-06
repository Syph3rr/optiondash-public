# OptionDash

A local trading platform, built as modules behind one Rust server:

- **Options Analyser:** an OptionStrat-style options analyser. Edit legs in the browser and see P&L, a P&L heatmap and position Greeks across price and time. The Rust server prices with [OptionStratLib](https://github.com/joaquinbejar/OptionStratLib).
- **Journal** (`/journal/`): log structured options trades, review them, and see analytics across all of them. The Trades page follows the shared **Accounts** filter (top right), shows each trade's account, and moves ticked trades to another account in bulk (with Undo). New trade and the trade page have an Account select.
- **Home, Portfolio, Chain & screener:** a home page of cards (including all the journal analytics) that you can rearrange, resize, hide and lock with **Edit layout** (the journal cards follow the **Accounts** filter at the top right, with a "Showing … only" note while some accounts are unticked), your positions and cash per account (grouped by journal trade) with net Greeks, and option chains with skew, a contract screener and a TradingView price chart with its own symbol search (online only; delayed data).

**Settings** (`/settings`, pinned at the bottom of the sidebar) holds the theme (System, Dark or Light) and the rate and dividend-yield defaults, saved per browser, plus the TWS connection (Connect / Disconnect) and **Accounts**: add, rename, reorder (↑↓) and delete journal accounts, set an IBKR account's broker ref (its account number, used to file imported fills) or an Other account's source. Deleting an account that has trades moves them to the account you pick.

Click a section below to expand it. **Architecture** and **Plans** cover how it is built and what comes next.

## Getting started

You need:

- **Rust:** install with [rustup](https://rustup.rs/).
- **Python 3.12 or newer:** from [python.org](https://www.python.org/downloads/). Tick "Add python.exe to PATH" on Windows.
- **IBKR market data:** in Client Portal, go to **Settings → Market Data Subscriptions** and add **OPRA (US Options Exchanges) (NP, L1)**. It costs about $1.50/month. Without it, option quotes are delayed.

Then:

```bash
pip install -r services/market/requirements.txt -r modules/journal/requirements.txt
cargo run --release
```

Open http://127.0.0.1:3000. To use TWS, enable its API first (see **Live market data → Setup** below), then go to **Settings** and press **Connect**. Your journal database is created automatically on first start.

<details>
<summary><b>What you can do</b></summary>

- **Legs:** add calls, puts and stock/futures; buy or sell; set quantity, strike, DTE, IV, premium and multiplier.
  - Option legs default to a multiplier of 100 under every model. ES options need 50 set by hand.
  - Untick a leg to exclude it.
  - DTE takes decimals, so `0.25` is 6 hours (0DTE).
- **Premium:** the price now. Leave it blank to use the theoretical value.
  - **IV←** solves the leg's implied vol from the premium you typed.
- **My fill:** the price you paid or received per share. When a leg has one, P&L and the payoff curves are measured from it; legs without a fill use the premium as before.
  - The **Position vs my fills** panel shows each leg's fill, current price, change and unrealised P&L, and the total.
  - With an entry date, underlying at entry and IV at entry it splits the total since entry into underlying move, time decay, IV change and other. Each filled leg is repriced exactly by the engine at the entry state and step by step to now (spot, then time, then IV); "other" is what the model doesn't explain, mostly fill and market price versus model value. IV at entry shifts every leg's IV by the same amount, so skew is kept.
  - **Current prices: Manual / Market.** Manual: type prices in Premium. Market: fills Premium (mid, or last) and IV from market data for legs on a listed contract, and spot from the underlying. It fetches once on load and when you press **Refresh prices**; it never polls or connects by itself. Without market data it says so and keeps your typed prices. On the first fetch after switching from Manual, a leg with a typed premium but no fill keeps that premium as its fill (older set-ups typed the entry price there). This is separate from the market bar's **Live** switch, which keeps spot and IV updating but never changes premiums.
  - Opening a journal trade (`?journal_trade=N`) fills My fill from each leg's average open price, and the entry fields from the trade.
- **Saved analyses:** the bar at the top saves the whole set-up (legs with fills, symbol, spot, IV shift, rates, model, dates, price source, entry fields) by name in the journal database. Pick one and **Load**, **Save** again to overwrite it or save as new, or **×** to delete it (with a confirm). Live market data is switched off on load so it can't overwrite the saved spot.
- **Presets:** load common strategies (condor, butterfly, calendar, diagonal and more) from the Strategy menu.
  - Set **Days** first. Preset strikes scale with √time, so a 0DTE condor gets sensibly tight wings.
- **Date & time:** pick any minute from now to the last expiry. The selected time is priced exactly, not rounded to the chart grid.
  - **Day** steps through New York days and **Time** steps 15 minutes within the day. Use the sliders, ◀ ▶, arrow keys or the mouse wheel, or type a date and time.
  - **Now**, **Open**, **Close** and **Expiry** jump straight there. Open and Close use the selected day; click Expiry again to cycle through leg expiries.
  - Times are New York time, with your local time shown beside them.
  - The P&L chart shows the selected date (amber) against the first expiry (blue dashed).
  - For trades under two days the time axis switches to hours.
- **IV shift:** shifts every leg's vol in parallel. Type a value, or step 0.1 pts with ◀ ▶, arrow keys or the mouse wheel. **Reset** or double-click returns it to zero.
- **Forward IV:** appears under the legs whenever two active option legs sit on different expiries, whichever side or type they are. It uses the IVs being priced, including typed IVs and the IV shift, and updates with Live.
  - A double calendar gets one line per strike, and three expiries on one strike get a line for each neighbouring pair.
  - Legs with different strikes are tagged `diagonal`, and a call against a put is tagged `call/put`, because those numbers include skew as well as term structure. Legs on one type and strike pair first. The rest match by type, then opposite side, then nearest strike.
  - If total variance falls from front to back, the line says `Inverted` instead of showing a number.
  - It is display only. The P&L chart still prices each leg at its own IV.
- **Price range:** sets automatically from the expected move and strikes. Changing it fixes the range in steps of 0.5%; **Auto** or double-click returns to auto.
- **Views:**
  - P&L
  - Chart: TradingView price chart of the loaded symbol (delayed, needs internet; the P&L controls hide on this tab)
  - Heatmap (price × date)
  - Greeks × Price (selected date vs today)
  - Greeks × Time (at spot)
- **Summary:** net debit/credit, max profit/loss, breakevens, probability of profit and the 1σ move.
- **Persistence:** everything is saved in your browser's storage, so a refresh keeps your strategy.

<details>
<summary>Assumptions</summary>

- **Sticky strike:** each leg keeps its own IV as time passes.
- **Expired legs:** when the date slider passes a leg's expiry, that leg settles at intrinsic value at that price.
- **Probability of profit:** uses a lognormal at the legs' mean IV, at the first expiry.

</details>

</details>

<details>
<summary><b>Your data</b></summary>

The journal database is `data/journal/trades.db`, with screenshots in `data/journal/screenshots/`. A copy of the database goes to `data/journal/backups/` each time the journal starts (the newest 20 are kept; backups are not tracked by git). Set `JOURNAL_DATA` to keep it somewhere else.

**Accounts:** every journal trade belongs to one account, and each account has one source of truth for its positions. An **IBKR** account reads TWS (its saved snapshot or a CSV upload is the fallback); a **Paper** account's positions are its open journal trades; an **Other** account (another broker) takes them from a CSV upload or from the journal, chosen per account. A new journal starts with an IBKR and a Paper account, and trades from before accounts existed are in IBKR (move examples to Paper in bulk). A trade made from IBKR fills goes to the IBKR account whose account number matches the fills, else the first IBKR account. Home, Portfolio and Trades share one account filter (all accounts by default), remembered in this browser; an account you add later is included until you untick it.

**Saved positions:** the same database keeps a portfolio snapshot per account, so Portfolio and its Home card still show your positions (and cash, if you gave it) when TWS isn't connected. Every successful TWS read replaces the snapshot of each IBKR account it has positions or cash for (and of the first IBKR account, which takes positions from unknown account numbers). Without TWS, or for an **Other** account with a CSV source, open **Saved positions** on the Portfolio page, pick the account and upload a CSV (**Download template** shows the format). The `type` column is `stock`, `call` or `put`: stocks leave strike and expiry blank, and options need both. A bad file is refused as a whole, with every problem listed by row.

**Portfolio by account:** the page shows the accounts ticked in the **Accounts** filter (header, next to Refresh), each from its one source: TWS rows go to the IBKR account whose broker ref matches the row's account number (any case), else the first IBKR account; without TWS an IBKR account shows its saved snapshot. The tiles add up positions and cost over the shown accounts, and cash when it shares a currency (otherwise the largest currency is shown and the others named). Each account is a slim section with its type and source (**TWS live**, **Saved …**, **CSV …** or **Journal**) and its positions grouped by open journal trade, each group linked to its trade. For TWS and CSV accounts the journal only labels the broker's rows: oldest trade first, each journal leg claims broker quantity on the same contract with the same sign, up to its own quantity. What no trade claims is **Not in journal**, with a **Log as trade** link that opens New trade prefilled with that position; a journal leg the broker doesn't hold shows as "Journal says open, broker doesn't hold it". **Load Greeks** prices each underlying once and shows $ delta, theta, vega and unrealised P&L per group and per account. By underlying and By expiry are folded at the bottom. The Home **Portfolio** card shows the same totals for the same filter.


</details>

<details>
<summary><b>Architecture</b></summary>

OptionDash is one Rust **gateway** in front of **modules** and **services**:

- **Gateway** (`src/`): the front door on 127.0.0.1. It serves the embedded pages and assets, exposes the pricing engine at `/api/analyze` and `/api/iv`, and supervises the Python services: it starts them, restarts them with backoff if they die, and routes their calls. Modules that run their own HTTP server (the journal) sit on a private localhost port and the gateway proxies to them.
- **Security:** the gateway refuses any request whose Host isn't `127.0.0.1` or `localhost` (DNS rebinding), and any POST/PUT/PATCH/DELETE that the browser marks as cross-site (a foreign `Origin` or `Sec-Fetch-Site: cross-site`). A web page you visit can't read your journal or press Connect IBKR for you. The journal applies the same rules itself.
- **Engine** (`crates/engine/`): the pricing library (OptionStratLib, plus an `f64` BAW port), shared by the gateway and every module that needs prices or Greeks.
- **Modules** (`modules/`): one folder per section of the app. `analyser/`, `home/`, `portfolio/` and `chain/` are static pages embedded in the binary; `journal/` is a Python FastAPI service with SQLite, run on `127.0.0.1:3101` and proxied at `/journal` and `/api/journal`. The gateway listens on `127.0.0.1:3000` (`PORT` overrides).
- **Services** (`services/`): Python processes the gateway supervises. `services/market` holds the market data and the platform's **one TWS connection** (see **One TWS connection** under Live market data).
- **TWS is only contacted when you press Connect.** Nothing connects at start-up, and nothing retries in the background.

**Adding a module:** copy `modules/_template/` (it has a step-by-step checklist), or put it in `modules/<name>/`, and add it to the `MODULES` registry in `web/shared/nav.js` so it appears in the sidebar. A module with only static pages gets an asset table and a route in `src/assets.rs`. A module with its own Python server gets a `ServiceConfig` in `src/main.rs` (like `journal_config`: program, script, private port, env) and a `proxy::router(.., &["/<name>", "/api/<name>"])` line. The supervisor, proxy and security layer are shared.
- **Shared web** (`web/shared/`): the theme, the nav bar and vendored Plotly, used by every module's pages.

<details>
<summary>URLs</summary>

| URL | What |
|---|---|
| `/` | Options Analyser page |
| `/analyser/<file>` | Analyser scripts |
| `/shared/theme.css`, `/shared/nav.js`, `/shared/vendor/plotly.min.js` | Shared assets |
| `/api/analyze`, `/api/iv` | Pricing engine |
| `/api/market/*` | Market data service |
| `/api/broker/*` | The shared TWS connection: status, connect, disconnect, executions, positions, account (cash) |
| `/home`, `/home/static/<file>` | Home page (widget grid) and its scripts |
| `/settings`, `/settings/static/<file>` | Settings: theme, pricing defaults, TWS status, accounts |
| `/portfolio`, `/portfolio/static/<file>` | Portfolio page and its scripts |
| `/chain`, `/chain/static/<file>` | Chain & screener page and its scripts |
| `/journal/`, `/journal/trade?id=N` | Trade journal pages (proxied). New trade and IBKR fill import are panels on `/journal/` (`?new=1`, `?import=1`); `/journal/new` redirects there and `/journal/dashboard` redirects to Home. `/journal/ibkr` redirects to the import panel; Connect / Disconnect live in Settings. |
| `/api/journal/*` | Trade journal API (proxied) |

</details>

</details>

<details>
<summary><b>Layout</b></summary>

```
Cargo.toml              workspace: the gateway binary + crates/engine
src/                    gateway: main.rs (router), assets.rs (embedded pages), supervisor.rs, service.rs,
                        proxy.rs, security.rs, market.rs + market/ (/api/market/*), broker.rs (/api/broker/*)
crates/engine/          pricing grid, Greeks, summary stats, IV solver
modules/analyser/web/   analyser page and scripts (vanilla JS + Plotly)
modules/journal/        trade journal: Python service (app/), pages (static/)
modules/home/web/       Home page and its system widgets
modules/portfolio/web/  Portfolio page and its Home widget
modules/chain/web/      Chain & screener page
modules/_template/      copyable module skeleton and checklist
web/shared/             theme.css, nav.js (module registry), widgets.js (Home registry), fonts/, vendor/plotly
services/market/        Python market data service: IBKR first, Yahoo as fallback
tests/                  Node tests for the browser scripts, fixtures for the gateway tests
```

</details>

<details>
<summary><b>Live market data</b></summary>

OptionDash can fill spot, strikes, DTE, IV and premium from Interactive Brokers, with Yahoo Finance as the fallback. `cargo run` starts everything; there is no second command.

**The account has live OPRA (US Options Exchanges) (NP, L1) data**, so option quotes come through live with no code or config change (without a subscription they would be delayed). The underlying's price comes from Yahoo unless a stock feed is added, so spot can lag the live option quotes: see **Known limits** below.

Without Python, the app works exactly as described above, except that the Live box is disabled and the header says why.

<details>
<summary>Setup</summary>

1. Install Python 3.12 or newer, then the libraries for the market service and the journal (if the journal cannot start, the analyser still works and the journal pages say why):

   ```bash
   pip install -r services/market/requirements.txt -r modules/journal/requirements.txt
   ```

2. In TWS, open **Global Configuration → API → Settings**:
   - Tick **Enable ActiveX and Socket Clients**.
   - Set **Socket port** to `7496`, or set `IBKR_PORT` to match your port.

With TWS closed, the app still works from Yahoo. The connection is read-only: it never places, cancels or exercises orders.

The app never connects to TWS on its own. Open TWS, then press **Connect IBKR** in the header. Each press makes one attempt, and a dropped connection is not retried: press Connect again.

</details>

<details>
<summary>One TWS connection</summary>

The whole platform shares **one** TWS session, owned by the market service (`services/market`):

- **Client id** `17` (`IBKR_CLIENT_ID`), with the next four tried only if TWS says the id is in use.
- **Read-only:** `readonly=True`, and order sends (place, cancel, exercise) are blocked in the client itself. The only account reads allowed are executions, positions and a four-figure account summary (cash, net liquidation, available funds, buying power), each on request and never at connect time; every other account request (updates, P&L, managed accounts) is refused, and the tests pin that.
- **Reads:** market data for the analyser, plus executions (with commissions) and positions for the journal and the portfolio.
- **On demand only:** nothing connects at start-up or retries in the background. Press **Connect IBKR** (in Settings, on the TWS chip, or in the journal's import panel; all use this session): one attempt per press.

Modules reach it through the gateway:

| Endpoint | Method | Success (200) body | Errors |
|---|---|---|---|
| `/api/broker/status` | GET | `{"sidecar": "online"\|"offline", "ibkr": "connected"\|"disconnected", "reason": str\|null}` | never fails: an unreachable service reads `"sidecar": "offline"` |
| `/api/broker/connect` | POST (JSON) | the market service's status after one attempt | 415 without a JSON content type |
| `/api/broker/disconnect` | POST (JSON) | status after disconnecting | 415 without a JSON content type |
| `/api/broker/executions` | GET | `{"executions": [...], "as_of": ...}` | 409 when TWS isn't connected |
| `/api/broker/positions` | GET | `{"positions": [...], "as_of": ...}` | 409 when TWS isn't connected |

Errors are `{"error": "..."}`:

- **409:** TWS not connected or the connection was lost (the message says to press Connect), or another account request is running (try again).
- **504:** TWS was too slow (the message says which request), or the market service didn't answer within the gateway's limit. Executions, positions and the account summary allow 25 s.
- **503:** the market service is offline.
- **502:** anything else, with the market service's message after `broker request failed:`.

`/api/market/status` and `/api/market/connect` remain as aliases.

The journal's fill import (`/journal/?import=1`) pulls executions from `/api/broker/executions`; the gateway passes it `BROKER_URL`. It has no TWS connection of its own.

| Environment variable | Default | Purpose |
|---|---|---|
| `IBKR_HOST` | `127.0.0.1` | TWS host |
| `IBKR_PORT` | `7496` | TWS socket port |
| `IBKR_CLIENT_ID` | `17` | API client id. If it is in use, the next four are tried. `0` is not allowed. |
| `OPTIONDASH_PYTHON` | the repo's `.venv`, else `python` (`python3` off Windows) | Python interpreter for the market service and the journal |
| `PORT` | `3000` | Gateway port |
| `JOURNAL_PORT` | `3101` | Private localhost port of the journal service |
| `JOURNAL_DATA` | `data/journal` | Journal database, screenshots and backups |

</details>

<details>
<summary>Using it</summary>

- **Symbol:** press Enter to load spot and the suggested model, and turn Live on. Loading a different symbol unlinks the old symbol's legs. Loading the same symbol again keeps the model you chose.
- **Live:** keeps spot, and the DTE and IV of linked legs, up to date. It polls every 5 s, or every 2 s when a value is LIVE, and pauses while the tab is hidden. Typing in the Underlying box turns Live off, so a what-if price is not overwritten.
- **+ From chain:** opens the chain for an expiry, with the strike nearest spot highlighted. Click an ask to add a BUY, or a bid to add a SELL. The new leg's premium is the mark. A price shown as `L 12.30` is the last trade, because there was no bid or ask. The table does not update itself, so it shows its age; **Refresh** loads it again.
- **Expiry menu:** once a symbol is loaded, each option leg has a menu of its listed expiries under the DTE box, by New York date (e.g. `Fri 6 Nov 26 · 4.3d`). Picking one sets the DTE, and the DTE then follows that date as time passes. Typing a DTE switches the menu to Custom DTE, and the date under the box shows which New York day that DTE lands on. DTE is time to settlement (16:00 New York, or 09:30 for SPX, NDX and RUT), so it can differ by a day from IBKR's day count, which starts from your own calendar date.
- **Sync to market:** links every unlinked leg to the expiry picked in its menu (or, for a Custom DTE, the nearest listed expiry) and to the nearest real strike for that expiry, and fills blank premiums. Typed premiums and typed IVs are kept. Stock legs get spot as a blank premium. A linked leg whose premium box was cleared gets the mark of its own contract, and nothing else about it changes.
  - A leg stays unlinked, and the status bar counts it, if its nearest strike is over 5% away (the message names that strike) or if it has a blank premium and no price is available.
  - Sync never puts two different legs on one contract, or a spread or calendar would net to nothing. The leg nearer that contract links, and a leg already linked always keeps it. Legs that start out identical stay together, and a straddle's put and call are different contracts.
  - A leg with a typed premium links even when the contract has no price yet.
  - With the market closed there is no bid or ask, so a blank premium is filled from the last trade. The status bar counts these (`4 premiums from the last trade (no live bid/ask)`, shown as a warning), and the leg's source badge says `last trade, no live bid/ask` on hover. It is never shown as a live mid.
- **Badges:** every market value shows where it came from: LIVE, DELAYED, FROZEN or YAHOO. STALE is added when no successful poll has covered the value for 30 s. Hover to see the time of the data itself, which can be much older, for example on a closed market. STALE alone does not detect a frozen feed, because a frozen feed still answers polls.
- **TWS losing IBKR:** TWS can lose its own connection to IBKR while staying connected to OptionDash. From error 1100 until 1101 or 1102, IBKR data counts as down: values come from Yahoo, and the header says TWS lost its connection to IBKR. With data lost (1101) the streams are rebuilt; with data maintained (1102) they carry on.
- **One-sided quotes:** a contract IBKR can't price, for example one with only an ask, takes its price from Yahoo and keeps IBKR's IV and delta. The badge reads YAHOO, because the price is Yahoo's.

**Greeks animation:** on *Greeks × Price* and *Greeks × Time*, a bar under the chart plays the Greeks from *From* to *To* (New York times). Blank From is now; blank To is the close (16:00 New York) the weekday before the first expiry, because on expiry day an at-the-money leg's theta and gamma climb so steeply that, on axes fixed for the whole run, every earlier frame would look flat. Type the expiry itself to play into it. One request prices 40 frames; the scrubber shows any of them, and *Clear* goes back to the selected date. On Greeks × Price the frame is amber and From is dotted; on Greeks × Time a playhead moves through the shaded From → To span.

**Earnings:** tick *Model the report* in the Earnings panel to see a position the morning after a report.

- **Report date:** filled in from Yahoo for the loaded symbol, with its timing when Yahoo has a time stamp on the same day; otherwise the panel says the timing is unknown, and *After close* is assumed. Type a date to override it; *Yahoo* looks it up again. Funds and indices have no date.
- **The model:** every expiry after the report carries the same one-off earnings variance on top of the stock's normal vol. The forward vol between the two nearest expiries after the report is the normal vol, and what the front holds above it is the earnings variance. The panel shows the implied move (1σ) and the normal vol. Each leg's IV after the report is its variance with the earnings part taken out, so the front falls much further than the back. This needs legs on two expiries after the report; a front priced at or under normal vol has no earnings premium, and nothing is crushed.
- **IV after:** each leg's box shows the model's estimate as its placeholder. Type your own number to override it; clear the box to go back to the model.
- **Chart:** purple is the P&L at 10:00 New York after the report (the same morning for *Before open*, the next weekday for *After close*), with today's entry prices kept. The shaded band is ±1σ of the implied move. **▶ Play** steps from today to that moment, moving time and IV together; the slider shows any step.
- The model assumes the normal vol is the same before and after the report. Holidays are not known, so a report before a holiday counts the next weekday.

**Linked legs:**

- Refreshing never changes premium, strike or expiry. Premium is your entry price, and P&L is measured from it.
- Typing a strike or DTE, or changing the type, unlinks the leg.
- Typing an IV, or using **IV←**, pins it. The leg stays linked and **typed ×** returns it to market IV.
- A leg past its expiry is unlinked, and that is checked when the page loads as well as on each poll.

Rate and dividend yield stay manual, and they feed the solved IVs.

</details>

<details>
<summary>Known limits</summary>

- Behaviour during market hours has not been checked in the app: only closed-market data has been seen there so far.
- Live option quotes with a Yahoo spot (no IBKR stock feed) can be out of step, which skews solved IV a little. The effect is largest on 0DTE.
- Yahoo fallback marks can be last-trade prices that are hours old. Hover over a YAHOO badge to see the time.
- Mid is a theoretical entry. Real fills differ, so the premium stays editable.
- The chain panel shows only the 25 strikes nearest spot. Sync is not limited to those.
- Futures options (ES, NQ, CL, GC) and ASX XJO have no market data here and stay manual.

</details>

</details>

<details>
<summary><b>Plans: market data collection</b></summary>

Agreed 2026-11-05. **Nothing here is built yet**; the collector (step 1) waits for a go-ahead, and anything that talks to IBKR needs TWS open to test. The aim is to build our own history of option data from IBKR, since other places charge a lot for it.

<details>
<summary>Universe</summary>

The top ~20 companies in the S&P 500 by options liquidity, not index options. Draft list, to confirm against IBKR volume and open interest before the first run: AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, AVGO, AMD, NFLX, JPM, COST, V, LLY, UNH, XOM, WMT, BAC, ORCL, CRM. Every underlying in the journal is added automatically. ETFs such as SPY and QQQ are not in the first list and can be added later.

</details>

<details>
<summary>Subscriptions</summary>

- **Have (live):** OPRA (US Options Exchanges) (NP, L1). It is the live streaming feed for option quotes, listed by IBKR at about US$1.50 a month for non-professionals (waivers depend on commissions). Non-professional means personal, non-business use.
- **Underlying prices:** use Yahoo for now (free; the app already falls back to it). Store each spot with its timestamp and source so staleness is visible. IBKR's stock feeds (Networks A, B and C, reportedly about US$4.50 a month in total) are only worth adding if the data shows a problem.
- **Not needed:** index data, Level 2 depth, and the news and research subscriptions. Nothing on IBKR's research list is needed; free ones include Wall Street Horizon, TipRanks Basic and Reflexivity Basic. If a news module ever needs an API feed, Benzinga (US$35 a month, one month free trial) is the only modest one; Dow Jones is US$78 and The Fly is US$600.
- **Later:** a Quote Booster (US$30 a month for 100 more market data lines) if the symbol list outgrows the line allowance.
- **Snapshot fees:** IBKR charges per "snapshot" request. The market service streams quotes instead (`reqMktData` without the snapshot flag), so those fees should not apply. Confirm on the first IBKR statement.

</details>

<details>
<summary>Step 1: intraday chain collector (first)</summary>

Per-option data is what makes the analysis good, and it is the one thing that cannot be recovered later: IBKR keeps no history of expired option contracts, so every day the collector is not running is lost. It comes before everything else.

- **Cadence:** every 30 minutes through the US session, denser (5 to 10 minutes) around earnings. Open interest once a day, because it only updates overnight.
- **Per contract:** timestamp, underlying price (with source), expiry, strike, right, trading class, bid, ask, last, sizes, volume, open interest, IBKR's IV and Greeks, and a live/delayed flag. Raw bid and ask are kept so IV can be recomputed with our own model.
- **Opt-in:** an explicit Start and Stop in the app, read-only, on the one shared TWS connection. The rule that nothing connects by itself still holds.
- **Lines:** IBKR allows 100 concurrent market data lines by default (more with commissions or equity), and one chain uses about 50. The collector sweeps one chain at a time and releases the lines before the next. Whether 20 symbols across several expiries fit in a 30-minute cycle is unknown until measured: it may mean fewer expiries, a longer interval or a booster.
- **Sydney hours:** the US session is overnight in Sydney, so the machine must stay awake and TWS logged in. IB Gateway restarts more reliably than TWS and is worth considering.
- **Storage:** a separate store (Parquet or DuckDB, partitioned by date), not git, with backups. Rough size: 150,000 rows a day for 20 symbols at 13 snapshots, a few hundred MB a year compressed.
- **Terms:** IBKR's market data terms restrict redistribution. Personal analysis is fine; read them before sharing the data.

</details>

<details>
<summary>Step 2: IV backfill (small, second)</summary>

Pull daily implied volatility, and historical (realised) volatility, for each symbol from IBKR so IV rank and percentile work immediately. This is a side benefit and deliberately small: per IBKR's docs it is **one underlying-level number per bar** (open, high, low, close of implied vol), available for stocks, ETFs and indices only, never for individual options. It has no skew, term structure or per-strike detail, so it cannot replace step 1.

- Needs TWS (IBKR only; Yahoo has no equivalent), so it is built against the fake IBKR client in the tests and run live later.
- An explicit **Backfill** button: it never connects on its own. Requests are paced to stay within IBKR's historical-data limits.
- Stored in a new local database under `data/marketdata/`, outside git and outside `trades.db`. Re-running updates rows instead of duplicating them.
- Then IV rank and percentile on the Chain page and Home.
- Bar sizes run from 1 second to 1 month, so intraday bars of this IV number may work. The docs do not say how far back each size goes, or the request limits (the page is deprecated; IBKR Campus may have them). Daily is the plan; about a year of history is assumed until checked.
- IBKR also says an active market data subscription is needed for historical data.

</details>

<details>
<summary>Step 3: what the data unlocks</summary>

- Term structure, skew history and IV rank on the Chain page.
- Implied move against realised move per earnings, the "Calibrate" step in the journal.
- A rough GEX and dealer-positioning view from open interest and Greeks.
- Automatic marks on open journal trades, and daily portfolio snapshots for "P&L today".

</details>

<details>
<summary>Checks for the first live TWS session</summary>

- Connect, load a symbol on the Chain page during market hours and confirm the option badges read LIVE and rows show deltas (Yahoo never provides them).
- Confirm the line allowance on the account and how many chains can load at once.
- Confirm no snapshot fees appear on the IBKR statement.
- Check IBKR's implied-volatility history for one symbol at daily and at 30-minute bars, and how far back each goes.
- Check whether IBKR serves historical price bars for individual option contracts that are still listed (it may partly fill the last few days or weeks before the collector starts). Expired contracts have no history.
- Check whether IBKR's Greeks need the stock feed for the underlying, or work with OPRA alone.

</details>

</details>

<details>
<summary><b>Roadmap</b></summary>

Easy ones first (no new data needed). Anything that needs data we don't have is parked.

**Look and shell**
- [ ] Per-page polish pass (analyser inline CSS to a stylesheet, KPI tiles, table styling on every journal page).
- [ ] Shared Plotly dark-layout helper used by both analyser and journal.

**Next up**
- [ ] **P&L Calendar day drill-down:** click a day on the P&L Calendar to open the trades that happened on that day (list them, each linking to its trade).
- [ ] **Analyser split view:** in the card holding the chart and the other options tabs, a left/right split down the middle so the chart can sit beside another tab.
- [ ] **Chain and screener split view:** the same left/right split, with the chart on one side and the other tabs on the other.

**Uses data we already have**
- [ ] **Journal analytics+ (part 2):** R-multiples and playbooks. Time of day: fills imported from IBKR keep their time, but fills typed into New trade are dates only, so a time-of-day view would cover IBKR fills only (or New trade would need a time field).
- [ ] **Portfolio (v3):** Greeks by expiry bucket, P&L today (needs yesterday's close), and a what-if spot/vol shift. Portfolio v2 is verified against a live server with fake positions, but not yet with real TWS positions.

**Needs the market data plans above**
- [ ] **Chain and screener (v2):** term structure (ATM IV per expiry) needs one chain load per expiry, so it should be an explicit button with a line budget. IV rank and percentile need the stored IV history (step 2). A multi-symbol scanner needs the symbol list and the same line budget.
- [ ] **GEX / dealer positioning:** needs open interest and Greeks across the full chain (step 1).

**Parked: needs data we don't have**
- [ ] **Options flow / market tide:** unusual activity, net premium, dark pool style feed. IBKR does not provide it; needs a paid flow feed (for example Unusual Whales or OptionStrat Flow), so pick a source first.
- [ ] **News and earnings calendar:** needs a news source (Yahoo earnings dates already exist for the analyser).
- [ ] **Alerts on saved filters:** depends on flow data.

Reference dashboards looked at: Unusual Whales (Super Flow modular layout), OptionStrat, Tastytrade, Thinkorswim, TradesViz, Tradervue, Edgewonk.

</details>
