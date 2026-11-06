"""Per-field fallback between IBKR and Yahoo. Every field falls back on its own."""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Callable

from broker import Broker
from contracts import clean, dte_days, nearest_strikes, resolve
from errors import NotFound
from ibkr import contract_key

log = logging.getLogger("sidecar.router")

QUOTES_YAHOO_WAIT = 2.0  # quotes must answer inside the caller's 3 s
UNDERLYING_BUDGET = 2.8  # whole `underlying` op; the caller allows 3 s
IBKR_CHAIN_BUDGET = 12.0  # of the 15 s the caller allows; the rest is for Yahoo
IBKR_CHAIN_MARGIN = 1.0  # kept back from the snapshot, so rows arrive before the budget ends
MULTIPLIER = 100
RIGHTS = ("C", "P")
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-]{1,10}$")
EXPIRY_RE = re.compile(r"^\d{8}$")
__all__ = ["NotFound", "Router"]
IBKR_ERRORS = (TimeoutError, ConnectionError)
CONTRACT_FIELDS = ("symbol", "expiry", "strike", "right", "trading_class")
NO_SPOT = {"price": None, "source": None, "data_type": None, "as_of": None}


def _symbol(args: dict) -> str:
    symbol = args.get("symbol")
    if not isinstance(symbol, str) or not SYMBOL_RE.match(symbol):
        raise ValueError("symbol must match ^[A-Z0-9.\\-]{1,10}$")
    return symbol


def _expiry(value) -> str:
    if not isinstance(value, str) or not EXPIRY_RE.match(value):
        raise ValueError("expiry must be YYYYMMDD")
    return value


def _trading_class(value) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("trading_class is required")
    return value


def _right(value) -> str | None:
    if value is not None and value not in RIGHTS:
        raise ValueError("right must be C or P")
    return value


def _contract(item) -> dict:
    if not isinstance(item, dict) or any(f not in item for f in CONTRACT_FIELDS):
        raise ValueError(f"each contract needs {', '.join(CONTRACT_FIELDS)}")
    _expiry(item["expiry"])
    _trading_class(item["trading_class"])
    if item["right"] not in RIGHTS or clean(item["strike"]) is None:
        raise ValueError("contract needs a positive strike and right C or P")
    return item


def _yahoo_view(row: dict) -> dict:
    """A new dict in the quote's field names; Yahoo's cached row stays untouched."""
    return {
        "bid": row.get("bid"), "ask": row.get("ask"), "last": row.get("last"),
        "mark": row.get("mark"), "mark_kind": row.get("mark_kind"),
        "delta": None, "ibkr_iv": None,
        "source": "yahoo", "data_type": "yahoo", "as_of": row.get("as_of"),
    }


def _ibkr_view(row: dict) -> dict:
    return {f: row.get(f) for f in (
        "bid", "ask", "last", "mark", "mark_kind", "delta", "ibkr_iv",
        "source", "data_type", "as_of")}


EMPTY_VIEW = {f: None for f in _ibkr_view({})}


def _no_mark(row: dict | None) -> bool:
    return row is None or row.get("mark") is None


def _merged_view(live: dict | None, yahoo: dict | None) -> dict | None:
    """One contract's row. An IBKR row with no mark counts as missing for price: Yahoo's prices
    arrive as one set with their source and time, and IBKR's IV and delta stay."""
    if _no_mark(live) and not _no_mark(yahoo):
        greeks = {} if live is None else {f: live.get(f) for f in ("delta", "ibkr_iv")}
        return {**_yahoo_view(yahoo), **greeks}
    if live is not None:
        return _ibkr_view(live)
    return None if yahoo is None else _yahoo_view(yahoo)


class Router:
    def __init__(self, ibkr, yahoo, now: Callable[[], datetime] | None = None, broker=None):
        self._ibkr = ibkr
        self._yahoo = yahoo
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._broker = broker if broker is not None else Broker(ibkr, now=self._now)
        self._task: asyncio.Task | None = None
        self._ops = {
            "status": self._status, "connect": self._connect, "disconnect": self._disconnect,
            "underlying": self._underlying, "expiries": self._expiries,
            "strikes": self._strikes, "chain": self._chain, "quotes": self._quotes,
            "earnings": self._earnings, "executions": self._executions,
            "positions": self._positions, "account": self._account,
        }

    # -- lifecycle ------------------------------------------------------------
    async def start(self) -> None:
        self._task = asyncio.create_task(self._ibkr.run_forever())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def handle(self, op: str, args: dict) -> dict:
        handler = self._ops.get(op)
        if handler is None:
            raise ValueError(f"unknown op {op!r}")
        if not isinstance(args, dict):
            raise ValueError("args must be an object")
        return await handler(args)

    # -- helpers --------------------------------------------------------------
    async def _ibkr_or(self, awaitable, default):
        try:
            return await awaitable
        except IBKR_ERRORS as exc:
            log.warning("ibkr failed, falling back: %r", exc)
            return default
        except Exception:  # Yahoo can still answer, so a bug here must not cost the request
            log.exception("unexpected ibkr failure, falling back")
            return default

    def _watch(self, contracts: list[dict]) -> dict:
        try:
            return self._ibkr.watch(contracts)
        except Exception:
            log.exception("unexpected ibkr failure in watch, falling back")
            return {}

    @staticmethod
    async def _thread(default, wait, fn, *args):
        """Runs a Yahoo call off the loop. Past `wait` the caller moves on; the thread
        still finishes and fills Yahoo's cache for the next poll."""
        call = asyncio.to_thread(fn, *args)
        if wait is None:
            return await call
        try:
            return await asyncio.wait_for(call, wait)
        except TimeoutError:
            log.warning("yahoo %s still running after %.1fs", fn.__name__, wait)
            return default

    async def _spot(self, u, yahoo_wait: float | None = None, **kwargs) -> dict | None:
        row = await self._ibkr_or(self._ibkr.spot(u, **kwargs), None)
        if row is None:
            row = await self._thread(None, yahoo_wait, self._yahoo.spot, u)
        return row

    async def _expiry_list(self, u) -> list[dict]:
        found = await self._ibkr_or(self._ibkr.expiries(u), [])
        if not found:
            found = await asyncio.to_thread(self._yahoo.expiries, u)
        return found

    def _base(self, symbol, expiry, strike, right, trading_class, dte) -> dict:
        return {"symbol": symbol, "expiry": expiry, "strike": float(strike), "right": right,
                "trading_class": trading_class, "multiplier": MULTIPLIER, "dte": dte}

    def _dte(self, expiry: str, trading_class: str) -> float:
        return dte_days(expiry, trading_class, self._now())

    # -- ops ------------------------------------------------------------------
    async def _status(self, _args: dict) -> dict:
        if self._ibkr.connected:
            return {"ibkr": "connected", "reason": None}
        return {"ibkr": "disconnected", "reason": self._ibkr.offline_reason}

    async def _connect(self, args: dict) -> dict:
        await self._ibkr.connect()
        return await self._status(args)

    async def _disconnect(self, args: dict) -> dict:
        await self._ibkr.disconnect()
        return await self._status(args)

    async def _executions(self, _args: dict) -> dict:
        return await self._broker.executions()

    async def _positions(self, _args: dict) -> dict:
        return await self._broker.positions()

    async def _account(self, _args: dict) -> dict:
        return await self._broker.account()

    async def _underlying(self, args: dict) -> dict:
        symbol = _symbol(args)
        u = resolve(symbol)
        info = {"symbol": symbol,
                "instrument": "index" if u.sec_type == "IND" else "stock",
                "suggested_model": u.suggested_model}
        spot = await self._underlying_spot(symbol, u)
        return {**(NO_SPOT if spot is None else spot), **info}

    async def _underlying_spot(self, symbol: str, u) -> dict | None:
        """The price row, or None for a known symbol that has no price. Everything runs
        concurrently inside UNDERLYING_BUDGET: an IBKR price wins, then Yahoo's. No price and
        an empty expiry list is NotFound; a lookup that did not finish is a retryable
        failure instead, since then we do not know."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + UNDERLYING_BUDGET
        ibkr = asyncio.create_task(self._ibkr_or(self._ibkr.spot(u), None))
        yahoo = asyncio.create_task(asyncio.to_thread(self._yahoo.spot, u))
        expiries = asyncio.create_task(self._expiry_list(u))
        tasks = (ibkr, yahoo, expiries)

        async def settle(*group) -> None:
            await asyncio.wait(group, timeout=max(0.0, deadline - loop.time()))

        try:
            await settle(ibkr)
            row = ibkr.result() if ibkr.done() else None
            if row is None:
                await settle(yahoo)
                row = yahoo.result() if yahoo.done() else None
            if row is not None:
                return row
            await settle(expiries, yahoo)
            if not expiries.done():
                raise TimeoutError(f"lookup of {symbol} timed out, try again")
            if not expiries.result():
                raise NotFound(f"no price or expiries for {symbol}")
            return None
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _expiries(self, args: dict) -> dict:
        symbol = _symbol(args)
        found = await self._expiry_list(resolve(symbol))
        if not found:
            raise NotFound(f"no expiries for {symbol}")
        return {"symbol": symbol, "expiries": [
            {**e, "dte": self._dte(e["expiry"], e["trading_class"])} for e in found]}

    async def _earnings(self, args: dict) -> dict:
        symbol = _symbol(args)
        found = await asyncio.to_thread(self._yahoo.earnings, resolve(symbol))
        return {"symbol": symbol, **found}

    async def _strikes(self, args: dict) -> dict:
        """Every real strike for one expiry, not only the chain window around spot. IBKR lists
        strikes across both rights; Yahoo's rows can be narrowed by `right`."""
        symbol = _symbol(args)
        expiry = _expiry(args.get("expiry"))
        trading_class = _trading_class(args.get("trading_class"))
        right = _right(args.get("right"))
        u = resolve(symbol)
        listed = await self._ibkr_or(asyncio.wait_for(
            self._ibkr.strikes(u, expiry, trading_class), IBKR_CHAIN_BUDGET), None)
        chain = {}
        if not listed:
            chain = await asyncio.to_thread(self._yahoo.chain, u, expiry, trading_class)
        found = listed or sorted({k for k, r in chain if right in (None, r)})
        if found:
            return {"symbol": symbol, "expiry": expiry, "trading_class": trading_class,
                    "strikes": found}
        # Yahoo also answers {} when it fails, so an empty chain alone proves nothing.
        if chain or (listed == [] and self._ibkr.connected):
            raise NotFound(f"no strikes for {symbol} {expiry}")
        raise TimeoutError(f"lookup of {symbol} {expiry} did not finish, try again")

    async def _quotes(self, args: dict) -> dict:
        symbol = _symbol(args)
        contracts = args.get("contracts")
        if not isinstance(contracts, list):
            raise ValueError("contracts must be a list")
        contracts = [_contract(c) for c in contracts]
        u = resolve(symbol)
        live = self._watch(contracts)
        missing = {(c["expiry"], c["trading_class"]) for c in contracts
                   if _no_mark(live.get(contract_key(c)))}
        spot, yahoo_chains = await asyncio.gather(
            self._spot(u, yahoo_wait=QUOTES_YAHOO_WAIT, wait=0.0),
            self._yahoo_chains(u, missing))
        quotes = [self._quote(c, live.get(contract_key(c)), yahoo_chains) for c in contracts]
        return {"underlying": NO_SPOT if spot is None else spot, "quotes": quotes}

    async def _yahoo_chains(self, u, wanted) -> dict:
        wanted = sorted(wanted)
        chains = await asyncio.gather(
            *(self._thread({}, QUOTES_YAHOO_WAIT, self._yahoo.chain, u, e, tc) for e, tc in wanted))
        return dict(zip(wanted, chains))

    def _quote(self, c: dict, live: dict | None, yahoo_chains: dict) -> dict:
        base = self._base(c["symbol"], c["expiry"], c["strike"], c["right"],
                          c["trading_class"], self._dte(c["expiry"], c["trading_class"]))
        chain = yahoo_chains.get((c["expiry"], c["trading_class"]), {})
        view = _merged_view(live, chain.get((float(c["strike"]), c["right"])))
        return {**base, **(EMPTY_VIEW if view is None else view)}

    async def _chain(self, args: dict) -> dict:
        symbol = _symbol(args)
        expiry = _expiry(args.get("expiry"))
        trading_class = _trading_class(args.get("trading_class"))
        u = resolve(symbol)
        price = clean(args.get("spot"))
        if price is None:
            spot = await self._spot(u, wait=0.0)
            price = None if spot is None else spot["price"]
        if price is None:
            raise NotFound(f"no price for {symbol}")

        strikes, snap = await self._ibkr_chain(u, expiry, trading_class, price)
        need_yahoo = not strikes or any(
            _no_mark(snap.get((k, r))) for k in nearest_strikes(strikes, price) for r in RIGHTS)
        yahoo = (await asyncio.to_thread(self._yahoo.chain, u, expiry, trading_class)
                 if need_yahoo else {})
        if not strikes:
            strikes = sorted({k for k, _ in yahoo})

        dte = self._dte(expiry, trading_class)
        rows = []
        for strike in nearest_strikes(strikes, price):
            for right in RIGHTS:
                view = _merged_view(snap.get((strike, right)), yahoo.get((strike, right)))
                if view is not None:
                    rows.append({**self._base(symbol, expiry, strike, right, trading_class,
                                              dte), **view})
        return {"expiry": expiry, "trading_class": trading_class, "dte": dte,
                "spot": price, "rows": rows}

    async def _ibkr_chain(self, u, expiry, trading_class, price) -> tuple[list, dict]:
        """Whatever IBKR delivered within its share of the time. The snapshot gets what the
        strikes left, so it hands back its rows before the budget runs out; a stall after the
        strikes arrived still keeps the strikes."""
        found: dict = {"strikes": [], "snapshot": {}}
        loop = asyncio.get_running_loop()
        deadline = loop.time() + IBKR_CHAIN_BUDGET

        async def work() -> None:
            found["strikes"] = await self._ibkr.strikes(u, expiry, trading_class)
            if found["strikes"]:
                window = nearest_strikes(found["strikes"], price)
                left = max(0.0, deadline - loop.time() - IBKR_CHAIN_MARGIN)
                found["snapshot"] = await self._ibkr.snapshot(
                    u, expiry, trading_class, window, wait=left)

        await self._ibkr_or(asyncio.wait_for(work(), IBKR_CHAIN_BUDGET), None)
        return found["strikes"], found["snapshot"]
