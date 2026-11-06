"""IBKR (TWS) source: the one shared connection, its streams and snapshots.

Read-only by design: it reads market data, executions, positions and a four-figure cash
summary, and never sends an order (refused per method and again by message id at the wire). It connects only
when the user presses Connect IBKR, one attempt per press; that attempt moves on to the
next client id (up to CLIENT_ID_ATTEMPTS) only when TWS says the id is already in use."""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Coroutine

from ib_async import IB, Contract, Index, Option, Stock, Ticker
from ib_async.ib import StartupFetchNONE

from contracts import (
    DATA_TYPES,
    STANDARD_MULTIPLIER,
    Underlying,
    clean,
    mark,
    merge_expiries,
)

log = logging.getLogger("sidecar.ibkr")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 7496
DEFAULT_CLIENT_ID = 17
CLIENT_ID_ATTEMPTS = 5
CLIENT_ID_IN_USE = 326
LINK_LOST = 1100  # TWS lost IBKR: our socket stays up and every ticker silently freezes
DATA_LOST = 1101  # connectivity restored, subscriptions must be requested again
DATA_KEPT = 1102  # connectivity restored, subscriptions carry on
DELAYED_FROZEN = 4
OPTION_GENERIC_TICKS = "101,106"
SPOT_GENERIC_TICKS = ""
CURRENCY = "USD"
OPTION_EXCHANGE = "SMART"
RIGHTS = ("C", "P")

LINE_BUDGET = 60
IDLE_SECONDS = 60.0
REQUALIFY_SECONDS = 60.0
PRUNE_SECONDS = 10.0
LINK_DOWN_REASON = "TWS lost its connection to IBKR"
DISCONNECTED_REASON = "disconnected; press Connect IBKR"
CONNECT_TIMEOUT = 4.0
REQUEST_TIMEOUT = 4.0
SPOT_WAIT = 2.0
SNAPSHOT_WAIT = 6.0
POLL_SECONDS = 0.05

# The only account traffic allowed out, read on request: executions, positions, and the
# account summary (always the four tags below, never the library's whole-summary request).
ALLOWED_ACCOUNT_SENDS = ("reqExecutions", "reqPositions", "cancelPositions",
                         "reqAccountSummary", "cancelAccountSummary")
ACCOUNT_SUMMARY_TAGS = ("TotalCashValue", "NetLiquidation", "AvailableFunds", "BuyingPower")

BLOCKED_CLIENT_SENDS = (
    # account, beyond the reads above
    "reqPositionsMulti", "cancelPositionsMulti",
    "reqAccountUpdates",
    "reqAccountUpdatesMulti", "cancelAccountUpdatesMulti", "reqManagedAccts",
    "reqPnL", "reqPnLSingle", "cancelPnL", "cancelPnLSingle", "reqUserInfo",
    "reqFamilyCodes", "reqSoftDollarTiers", "requestFA", "replaceFA",
    # orders: never
    "reqOpenOrders", "reqAllOpenOrders", "reqAutoOpenOrders", "reqCompletedOrders",
    "reqIds", "placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions",
)

# Outgoing TWS message ids for order operations, refused again at the wire-level send
# in case a library change ever routes around the method-level guards above.
BLOCKED_MESSAGE_IDS = frozenset({
    3,   # PLACE_ORDER
    4,   # CANCEL_ORDER
    5,   # REQ_OPEN_ORDERS
    8,   # REQ_IDS
    15,  # REQ_AUTO_OPEN_ORDERS
    16,  # REQ_ALL_OPEN_ORDERS
    21,  # EXERCISE_OPTIONS
    58,  # REQ_GLOBAL_CANCEL
    99,  # REQ_COMPLETED_ORDERS
})


class BlockedRequest(RuntimeError):
    """An order or account request was stopped before reaching TWS."""


def _message_id(first_field) -> int | None:
    try:
        return int(first_field)
    except (TypeError, ValueError):
        return None


def _guard_send(send: Callable[..., None]) -> Callable[..., None]:
    def guarded(*fields, **kwargs) -> None:
        if fields and _message_id(fields[0]) in BLOCKED_MESSAGE_IDS:
            log.error("refused message id %s at the wire: orders are never sent", fields[0])
            raise BlockedRequest(f"message {fields[0]}")
        return send(*fields, **kwargs)

    return guarded


def _guard_send_msg(send_msg: Callable[[str], None]) -> Callable[[str], None]:
    def guarded(msg) -> None:
        if msg and _message_id(str(msg).split("\0", 1)[0]) in BLOCKED_MESSAGE_IDS:
            log.error("refused a raw order message at the wire")
            raise BlockedRequest("raw order message")
        return send_msg(msg)

    return guarded


def _refuse_send(name: str) -> Callable[..., None]:
    def refuse(*_args, **_kwargs) -> None:
        log.error("refused %s: the broker reads executions and positions only, "
                  "and never sends orders", name)
        raise BlockedRequest(name)

    return refuse


async def _no_account_data(*_args, **_kwargs) -> list:
    return []


class BrokerIB(IB):
    """`IB` that fails closed. ib_async 2.1 asks for account data on its own: positions
    in `connectAsync` whatever `fetchFields` says, and the account summary on error
    1102. Internal paths like those get an empty answer here, so connecting sends
    nothing and nothing hangs, and the client refuses the send itself for anything
    that gets past them.

    Executions, positions and the cash summary are read only through `fetch_executions`,
    `fetch_positions` and `fetch_account_summary`, which the broker calls when asked.
    Orders are never sent.

    `cancelMktData` also forgets the Ticker. The library keeps it and hands it to the
    next request for that contract, old values included, so a fresh request would look
    answered before TWS had replied."""

    read_only_guarded = True

    reqPositionsAsync = _no_account_data
    reqAccountSummaryAsync = _no_account_data
    accountSummaryAsync = _no_account_data
    reqAccountUpdatesAsync = _no_account_data
    reqAccountUpdatesMultiAsync = _no_account_data
    reqOpenOrdersAsync = _no_account_data
    reqAllOpenOrdersAsync = _no_account_data
    reqCompletedOrdersAsync = _no_account_data
    reqExecutionsAsync = _no_account_data
    whatIfOrderAsync = _no_account_data
    requestFAAsync = _no_account_data
    reqUserInfoAsync = _no_account_data

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for name in BLOCKED_CLIENT_SENDS:
            setattr(self.client, name, _refuse_send(name))
        # Defence in depth: every client method funnels through send -> sendMsg.
        self.client.send = _guard_send(self.client.send)
        self.client.sendMsg = _guard_send_msg(self.client.sendMsg)

    def reqAutoOpenOrders(self, autoBind: bool) -> None:
        """`connectAsync` calls this for client id 0."""

    def cancelMktData(self, contract: Contract) -> bool:
        cancelled = super().cancelMktData(contract)
        self.wrapper.tickers.pop(hash(contract), None)
        return cancelled

    async def fetch_executions(self) -> list:
        """This session's executions (TWS returns today's, or up to 7 days if set)."""
        return await IB.reqExecutionsAsync(self)

    async def fetch_positions(self) -> list:
        """Positions once. The subscription TWS starts is cancelled however the read
        ends (answered, timed out or cancelled), so TWS never keeps streaming them."""
        try:
            return await IB.reqPositionsAsync(self)
        finally:
            try:
                self.client.cancelPositions()
            except ConnectionError:  # socket already gone: nothing is streaming
                pass

    async def fetch_account_summary(self) -> list:
        """Cash, net liquidation, available funds and buying power, once. Only those four
        tags are asked for (the library's own request asks for dozens, including the
        whole ledger, and stays neutered above). The request is cancelled however the
        read ends, so TWS never keeps streaming a summary nobody is waiting for."""
        req_id = self.client.getReqId()
        answered = self.wrapper.startReq(req_id)
        self.client.reqAccountSummary(req_id, "All", ",".join(ACCOUNT_SUMMARY_TAGS))
        try:
            await answered
        finally:
            try:
                self.client.cancelAccountSummary(req_id)
            except ConnectionError:  # socket already gone: nothing is streaming
                pass
        return [v for v in self.wrapper.acctSummary.values() if v.tag in ACCOUNT_SUMMARY_TAGS]

    def fail_pending_requests(self, reason: str) -> None:
        """Fail every request still waiting on TWS. `IB.disconnect` clears the wrapper's
        futures without failing them, so a read in flight would hang until timeout."""
        for future in list(getattr(self.wrapper, "_futures", {}).values()):
            if not future.done():
                future.set_exception(ConnectionError(reason))
                future.exception()  # retrieved here, so nothing logs it as unhandled


MarketDataIB = BrokerIB  # the name before the broker shared this connection


def contract_key(contract: dict) -> tuple:
    return (float(contract["strike"]), contract["right"], contract["expiry"],
            contract["trading_class"])


def underlying_contract(u: Underlying) -> Contract:
    if u.sec_type == "IND":
        return Index(u.symbol, u.exchange, CURRENCY)
    return Stock(u.symbol, u.exchange, CURRENCY)


def _option(contract: dict) -> Option:
    return Option(
        contract["symbol"], contract["expiry"], float(contract["strike"]), contract["right"],
        OPTION_EXCHANGE, STANDARD_MULTIPLIER, CURRENCY,
        tradingClass=contract["trading_class"],
    )


def _as_of(ticker: Ticker) -> str:
    """When the data last changed, so a frozen stream reads as stale, not fresh."""
    moment = ticker.time or datetime.now(timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean_delta(x) -> float | None:
    """`clean` rejects negatives, which would erase every put's delta."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and -1 <= v <= 1 else None


def _data_type(ticker: Ticker) -> str | None:
    return DATA_TYPES.get(ticker.marketDataType)


def _quote_row(ticker: Ticker | None) -> dict | None:
    if ticker is None:
        return None
    bid, ask, last = clean(ticker.bid), clean(ticker.ask), clean(ticker.last)
    if bid is None and ask is None and last is None:
        return None
    value, kind = mark(bid, ask, last)
    greeks = ticker.modelGreeks
    return {
        "bid": bid, "ask": ask, "last": last, "mark": value, "mark_kind": kind,
        "delta": _clean_delta(greeks.delta) if greeks else None,
        "ibkr_iv": clean(greeks.impliedVol) if greeks else None,
        "data_type": _data_type(ticker), "source": "ibkr", "as_of": _as_of(ticker),
    }


def _spot_row(ticker: Ticker | None) -> dict | None:
    if ticker is None:
        return None
    price, _ = mark(ticker.bid, ticker.ask, ticker.last)
    if price is None:
        return None
    return {"price": price, "source": "ibkr", "data_type": _data_type(ticker),
            "as_of": _as_of(ticker)}


def _settled(ticker: Ticker) -> bool:
    row = _quote_row(ticker)
    return row is not None and row["delta"] is not None


def _central_first(strikes: list[float]) -> list[float]:
    """The chain window is centred on spot, so its middle is what to keep."""
    ordered = sorted(strikes)
    middle = (len(ordered) - 1) / 2
    return [k for _, k in sorted((abs(i - middle), k) for i, k in enumerate(ordered))]


@dataclass
class _Stream:
    generic_ticks: str
    last_requested: float
    contract: Contract | None = None  # None until qualified
    ticker: Ticker | None = None      # None until requested on this connection


class IbkrSource:
    def __init__(
        self,
        ib: BrokerIB | None = None,
        clock: Callable[[], float] = time.monotonic,
        host: str | None = None,
        port: int | None = None,
        client_id: int | None = None,
    ):
        self._ib = BrokerIB() if ib is None else ib
        if not getattr(self._ib, "read_only_guarded", False):
            raise TypeError("IbkrSource needs a BrokerIB, which refuses order requests")
        self._clock = clock
        self._host = os.environ.get("IBKR_HOST", DEFAULT_HOST) if host is None else host
        self._port = int(os.environ.get("IBKR_PORT", DEFAULT_PORT)) if port is None else port
        self._client_id = (int(os.environ.get("IBKR_CLIENT_ID", DEFAULT_CLIENT_ID))
                           if client_id is None else client_id)
        if self._client_id <= 0:  # connecting as id 0 sends reqAutoOpenOrders
            raise ValueError(f"client id must be at least 1, got {self._client_id}")
        self._streams: dict[tuple, _Stream] = {}
        self._rejected: dict[tuple, float] = {}
        self._tasks: set[asyncio.Task] = set()
        self._snapshot_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._snapshot_keys: set[tuple] = set()
        self._snapshot_lines = 0
        self._offline_reason = "not connected to TWS; press Connect IBKR"
        self._link_down = False
        # Set when the user disconnects, so an account read in flight fails at once.
        self.session_closed = asyncio.Event()
        self._ib.errorEvent += self._on_error

    @property
    def _socket_up(self) -> bool:
        return self._ib.isConnected()

    @property
    def link_down(self) -> bool:
        """The socket is up but TWS has lost IBKR (error 1100): Connect cannot help."""
        return self._socket_up and self._link_down

    @property
    def ib(self) -> BrokerIB:
        """The guarded IB, for the broker's executions and positions reads."""
        return self._ib

    @property
    def connected(self) -> bool:
        """True while IBKR data can be believed: the socket can be up with TWS cut off from
        IBKR, and then rows look healthy but never change. Anything that talks to the socket
        itself, such as cancelling a line, asks `_socket_up` instead."""
        return self._socket_up and not self._link_down

    @property
    def offline_reason(self) -> str | None:
        if self.connected:
            return None
        return LINK_DOWN_REASON if self._socket_up else self._offline_reason

    # -- connection ----------------------------------------------------------
    async def connect_once(self) -> bool:
        """One connect cycle. Call it while disconnected; `connect` does.

        One press normally makes one attempt. Only when TWS answers 326 (this client id
        is already in use, e.g. by another app) does it try the next id, up to
        CLIENT_ID_ATTEMPTS ids in all; any other failure stops at once."""
        for client_id in range(self._client_id, self._client_id + CLIENT_ID_ATTEMPTS):
            codes: list[int] = []
            self._link_down = False  # a new session: its tickers hold nothing frozen

            def on_error(_req_id, code, _message, _contract) -> None:
                codes.append(code)

            self._ib.errorEvent += on_error
            try:
                await self._ib.connectAsync(
                    self._host, self._port, clientId=client_id, timeout=CONNECT_TIMEOUT,
                    readonly=True, fetchFields=StartupFetchNONE,
                )
            except Exception as exc:
                log.warning("connect as client %s failed: %r", client_id, exc)
                if CLIENT_ID_IN_USE not in codes:
                    self._offline_reason = self._connect_failure(exc)
                    return False
                continue
            finally:
                self._ib.errorEvent -= on_error
            self._offline_reason = "connection to TWS lost"  # if this one ever drops
            self.session_closed.clear()
            self._after_connect()
            return True
        last_id = self._client_id + CLIENT_ID_ATTEMPTS - 1
        self._offline_reason = (
            f"client ids {self._client_id}-{last_id} are in use (a press tries the next id "
            "only when TWS says one is taken); close the other API client or set IBKR_CLIENT_ID")
        return False

    def _connect_failure(self, exc: Exception) -> str:
        where = f"{self._host}:{self._port}"
        if isinstance(exc, TimeoutError):
            return f"TWS did not respond on {where}"
        if isinstance(exc, OSError):
            return f"TWS not reachable on {where}"
        return f"could not connect to TWS on {where}"

    def _after_connect(self) -> None:
        self._ib.reqMarketDataType(DELAYED_FROZEN)
        for key, stream in list(self._streams.items()):
            if stream.contract is not None:
                self._start(key, stream)

    def _on_error(self, _req_id, code, _message, _contract) -> None:
        if code == LINK_LOST:
            log.warning("%s: using Yahoo until it returns", LINK_DOWN_REASON)
            self._link_down = True
        elif code in (DATA_LOST, DATA_KEPT):
            self._link_down = False
            if code == DATA_LOST and self._socket_up:
                self._resubscribe()

    def _resubscribe(self) -> None:
        """The socket stayed up but TWS dropped the data: tickers would read as
        usable and never change again."""
        for key, stream in list(self._streams.items()):
            if stream.ticker is not None:
                self._ib.cancelMktData(stream.contract)
                self._start(key, stream)

    async def connect(self) -> bool:
        """One attempt, when asked. A socket that is already up is left alone."""
        async with self._connect_lock:
            return self._socket_up or await self.connect_once()

    async def disconnect(self) -> None:
        """Closes the socket when asked. Streams are forgotten: they reopen on demand
        after the next Connect, and nothing reconnects on its own."""
        async with self._connect_lock:
            # Account reads in flight fail now rather than waiting out their timeout.
            self.session_closed.set()
            fail_pending = getattr(self._ib, "fail_pending_requests", None)
            if fail_pending is not None:
                fail_pending("disconnected by the user")
            if self._socket_up:
                self._ib.disconnect()
            self._streams.clear()
            self._rejected.clear()
            self._link_down = False
            self._offline_reason = DISCONNECTED_REASON

    async def run_forever(self) -> None:
        """Housekeeping only. TWS is never contacted on its own: only `connect` (the
        Connect IBKR button) makes an attempt, one per press."""
        while True:
            try:
                self.prune()
            except Exception:
                log.exception("pruning streams failed")
            await asyncio.sleep(PRUNE_SECONDS)

    # -- public reads --------------------------------------------------------
    async def spot(self, u: Underlying, wait: float = SPOT_WAIT) -> dict | None:
        if not self.connected:
            return None
        key = ("spot", u.symbol)
        first = key not in self._streams
        stream = self._stream_for(key, lambda: underlying_contract(u), SPOT_GENERIC_TICKS)
        if stream is None:
            return None
        if first:
            await self._until(
                lambda: self._streams.get(key) is not stream or _spot_row(stream.ticker),
                self._clock() + wait,
            )
        return _spot_row(stream.ticker) if self.connected else None

    async def expiries(self, u: Underlying) -> list[dict]:
        if not self.connected:
            return []
        [contract] = await self._qualify([underlying_contract(u)])
        if contract is None:
            return []
        chains = await asyncio.wait_for(
            self._ib.reqSecDefOptParamsAsync(u.symbol, "", u.sec_type, contract.conId),
            REQUEST_TIMEOUT,
        )
        return merge_expiries(u, chains)

    async def strikes(self, u: Underlying, expiry: str, trading_class: str) -> list[float]:
        if not self.connected:
            return []
        query = Option(u.symbol, expiry, exchange=OPTION_EXCHANGE, currency=CURRENCY,
                       multiplier=STANDARD_MULTIPLIER, tradingClass=trading_class)
        details = await asyncio.wait_for(self._ib.reqContractDetailsAsync(query), REQUEST_TIMEOUT)
        found = (clean(d.contract.strike) for d in details if d.contract)
        return sorted({k for k in found if k is not None})

    async def snapshot(
        self,
        u: Underlying,
        expiry: str,
        trading_class: str,
        strikes: list[float],
        wait: float = SNAPSHOT_WAIT,
    ) -> dict[tuple[float, str], dict]:
        """Rows for the strikes the line budget covers, nearest the window's centre first. A
        missing key means no line or no data; the router fills it. `wait` covers the whole call,
        qualifying included, and running out returns the rows in hand."""
        if not self.connected:
            return {}
        deadline = self._clock() + wait
        specs = [
            {"symbol": u.symbol, "expiry": expiry, "strike": float(k), "right": right,
             "trading_class": trading_class}
            for k in _central_first(strikes) for right in RIGHTS
        ]
        async with self._snapshot_lock:
            return await self._snapshot(specs, deadline)

    def watch(self, contracts: list[dict]) -> dict[tuple, dict | None]:
        """Current rows, None where there is no usable tick. New contracts start
        qualifying in the background, so this returns without waiting on TWS."""
        out: dict[tuple, dict | None] = {}
        for contract in contracts:
            key = contract_key(contract)
            stream = self._stream_for(key, lambda c=contract: _option(c), OPTION_GENERIC_TICKS)
            out[key] = _quote_row(stream.ticker) if stream and self.connected else None
        return out

    def prune(self) -> None:
        now = self._clock()
        idle = [k for k, s in self._streams.items() if now - s.last_requested >= IDLE_SECONDS]
        for key in idle:
            stream = self._streams.pop(key)
            if stream.ticker is not None and self._socket_up:
                self._ib.cancelMktData(stream.contract)

    # -- streams -------------------------------------------------------------
    def _lines_in_use(self) -> int:
        return len(self._streams) + self._snapshot_lines

    def _may_open(self, key: tuple, now: float) -> bool:
        # A snapshot holding this contract must finish first: a second request
        # for one contract would orphan the first and leak its line.
        if not self.connected or key in self._snapshot_keys:
            return False
        if self._lines_in_use() >= LINE_BUDGET:
            return False
        rejected_at = self._rejected.get(key)
        if rejected_at is None:
            return True
        if now - rejected_at < REQUALIFY_SECONDS:
            return False
        del self._rejected[key]
        return True

    def _stream_for(
        self, key: tuple, build: Callable[[], Contract], generic_ticks: str
    ) -> _Stream | None:
        now = self._clock()
        stream = self._streams.get(key)
        if stream is not None:
            stream.last_requested = now
            return stream
        if not self._may_open(key, now):
            return None
        stream = _Stream(generic_ticks, now)
        self._streams[key] = stream  # holds the line while qualifying
        self._spawn(self._open(key, stream, build()))
        return stream

    def _spawn(self, coroutine: Coroutine) -> None:
        # Eager: runs up to its first real wait, so the caller never yields and
        # a pending network reply costs it nothing.
        task = asyncio.Task(coroutine, loop=asyncio.get_running_loop(), eager_start=True)
        if not task.done():
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _open(self, key: tuple, stream: _Stream, contract: Contract) -> None:
        try:
            [qualified] = await self._qualify([contract])
        except Exception as exc:  # disconnect or timeout: the next poll retries
            log.warning("qualifying %s failed: %r", key, exc)
            if self._streams.get(key) is stream:
                del self._streams[key]
            return
        if self._streams.get(key) is not stream:
            return  # pruned meanwhile
        if qualified is None:
            del self._streams[key]
            self._rejected[key] = self._clock()
            return
        stream.contract = qualified
        if self._socket_up:
            self._start(key, stream)

    def _start(self, key: tuple, stream: _Stream) -> None:
        """Failure frees the stream's line, and the next poll opens it again."""
        try:
            stream.ticker = self._ib.reqMktData(stream.contract, stream.generic_ticks)
        except Exception as exc:
            log.warning("requesting %s failed: %r", key, exc)
            self._streams.pop(key, None)

    async def _qualify(self, contracts: list[Contract]) -> list[Contract | None]:
        """Aligned with `contracts`; None for any that did not resolve to a conId."""
        results = await asyncio.wait_for(
            self._ib.qualifyContractsAsync(*contracts), REQUEST_TIMEOUT
        )
        return [c if c and c.conId else None for c in results]

    async def _until(self, done: Callable[[], object], deadline: float) -> None:
        while self.connected and not done() and self._clock() < deadline:
            await asyncio.sleep(POLL_SECONDS)

    # -- snapshots -----------------------------------------------------------
    async def _snapshot(self, specs: list[dict], deadline: float) -> dict[tuple[float, str], dict]:
        tickers: dict[tuple[float, str], Ticker] = {}
        fresh: list[dict] = []
        for spec in specs:
            stream = self._streams.get(contract_key(spec))
            if stream is None:
                fresh.append(spec)
            else:
                stream.last_requested = self._clock()
                if stream.ticker is not None:
                    tickers[(spec["strike"], spec["right"])] = stream.ticker
        fresh = fresh[:max(0, LINE_BUDGET - self._lines_in_use())]

        self._snapshot_keys = {contract_key(s) for s in fresh}
        self._snapshot_lines = len(fresh)
        opened: list[Contract] = []
        try:
            await self._open_within(fresh, tickers, opened, deadline)
            await self._until(lambda: all(_settled(t) for t in tickers.values()),
                              min(deadline, self._clock() + SNAPSHOT_WAIT))
            if not self.connected:
                return {}
            rows = {k: _quote_row(t) for k, t in tickers.items()}
            return {k: row for k, row in rows.items() if row is not None}
        finally:
            self._release(opened)

    async def _open_within(
        self,
        specs: list[dict],
        tickers: dict[tuple[float, str], Ticker],
        opened: list[Contract],
        deadline: float,
    ) -> None:
        if not specs:
            return
        try:
            await asyncio.wait_for(self._open_lines(specs, tickers, opened),
                                   max(0.0, deadline - self._clock()))
        except TimeoutError as exc:  # lines already streaming still have rows to give
            log.warning("no time to qualify %d snapshot contracts: %r", len(specs), exc)

    async def _open_lines(
        self, specs: list[dict], tickers: dict[tuple[float, str], Ticker], opened: list[Contract]
    ) -> None:
        qualified = await self._qualify([_option(s) for s in specs])
        for spec, contract in zip(specs, qualified):
            if contract is not None and self.connected:
                key = (spec["strike"], spec["right"])
                tickers[key] = self._ib.reqMktData(contract, OPTION_GENERIC_TICKS)
                opened.append(contract)
        self._snapshot_lines = len(opened)

    def _release(self, opened: list[Contract]) -> None:
        if self._socket_up:
            for contract in opened:
                self._ib.cancelMktData(contract)
        self._snapshot_keys = set()
        self._snapshot_lines = 0
