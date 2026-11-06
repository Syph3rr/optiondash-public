"""In-memory stand-in for the `ib_async.IB` methods that `IbkrSource` calls.

It opens no socket. It uses real ib_async data classes and copies the library
behaviour that bit the probes:
- `reqMktData` raises ValueError for a contract without a conId.
- Re-requesting a subscribed contract reuses its Ticker and orphans the first
  request, so that line stays open (`open_lines` counts it) until disconnect.
- `qualifyContractsAsync` fills conId in place, leaves None for a miss, and can
  hand back an entry with no conId (`left_unqualified`).
- A socket drop forgets every subscription and fails pending qualifications.

Two deliberate differences:
- It starts connected, because most tests exercise an open session. Pass
  `connected=False` to test the connect path from cold.
- `cancelMktData` forgets the Ticker. That is `MarketDataIB`'s behaviour, not plain
  `IB`'s, and `test_ibkr_readonly.py` proves it against the real wrapper.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from itertools import count

from eventkit import Event
from ib_async import ContractDetails, OptionChain, OptionComputation, Ticker
from ib_async.ib import StartupFetchALL

CLIENT_ID_IN_USE = 326
TICK_TIME = datetime(2026, 11, 1, 11, 0, 0, tzinfo=timezone.utc)


def ticker(bid=float("nan"), ask=float("nan"), last=float("nan"),
           close=float("nan"), md_type=4, iv=None, delta=None) -> Ticker:
    """A Ticker as ib_async fills it. Fields are set after construction because
    Ticker.__post_init__ resets them."""
    t = Ticker()
    return _apply(t, bid=bid, ask=ask, last=last, close=close, md_type=md_type,
                  iv=iv, delta=delta)


def _apply(t: Ticker, **fields) -> Ticker:
    iv, delta = fields.pop("iv", None), fields.pop("delta", None)
    md_type = fields.pop("md_type", None)
    for name, value in fields.items():
        setattr(t, name, value)
    if md_type is not None:
        t.marketDataType = md_type
    if iv is not None or delta is not None:
        t.modelGreeks = OptionComputation(0, impliedVol=iv, delta=delta)
    t.time = TICK_TIME
    return t


def _copy_quote(template: Ticker, contract) -> Ticker:
    t = Ticker(contract=contract)
    for name in ("bid", "ask", "last", "close", "marketDataType", "modelGreeks", "time"):
        setattr(t, name, getattr(template, name))
    return t


def _identity(contract) -> tuple:
    return (contract.symbol, contract.secType, contract.lastTradeDateOrContractMonth,
            contract.strike, contract.right, contract.tradingClass)


class FakeIB:
    read_only_guarded = True

    def __init__(self, default_ticker: Ticker | None = None, connected: bool = True):
        self.errorEvent = Event("errorEvent")
        self._connected = connected
        self._default = default_ticker
        self._con_ids = count(1000)
        self._known: dict[tuple, int] = {}
        self._reqs = count(1)
        self._req_ids: dict[int, int] = {}          # conId -> live reqId
        self._tickers: dict[int, Ticker] = {}       # conId -> Ticker
        self._orphans = 0
        self._drops = 0

        self.connect_kwargs: dict | None = None
        self.client_ids_tried: list[int] = []
        self.busy_client_ids: set[int] = set()
        self.refuse_connections = False
        self.connect_error: Exception | None = None
        self.market_data_type: int | None = None
        self.market_data_type_calls = 0

        self.mkt_data_requests: list = []            # (contract, genericTickList)
        self.cancelled: list = []
        self.unknown: set[tuple] = set()             # (symbol, strike, right) or (symbol,)
        self.left_unqualified: set[tuple] = set()    # returned as given, with no conId
        self.quotes: dict[tuple, dict] = {}          # (strike, right) -> tick fields
        self.qualify_gate: asyncio.Event | None = None
        self.qualify_error: Exception | None = None
        self.qualify_delay = 0.0
        self.details_delay = 0.0
        self.chains: list[OptionChain] = []
        self.details: list[ContractDetails] = []

    # -- ib_async.IB surface -------------------------------------------------
    def isConnected(self) -> bool:
        return self._connected

    async def connectAsync(self, host="127.0.0.1", port=7497, clientId=1, timeout=4,
                           readonly=False, account="", raiseSyncErrors=False,
                           fetchFields=StartupFetchALL):
        self.connect_kwargs = {
            "host": host, "port": port, "clientId": clientId, "timeout": timeout,
            "readonly": readonly, "account": account,
            "raiseSyncErrors": raiseSyncErrors, "fetchFields": fetchFields,
        }
        self.client_ids_tried.append(clientId)
        if self.refuse_connections:
            raise ConnectionRefusedError(f"connection refused on {host}:{port}")
        if self.connect_error is not None:
            raise self.connect_error
        if clientId in self.busy_client_ids:
            self.errorEvent.emit(-1, CLIENT_ID_IN_USE,
                                 "Unable to connect as the client id is already in use.", None)
            raise TimeoutError()
        self._connected = True
        return self

    def reqMarketDataType(self, marketDataType: int) -> None:
        self.market_data_type = marketDataType
        self.market_data_type_calls += 1

    def reqMktData(self, contract, genericTickList="", snapshot=False,
                   regulatorySnapshot=False, mktDataOptions=[]):
        if not contract.conId:
            raise ValueError(f"Contract {contract} can't be hashed: no 'conId' value exists.")
        if not self._connected:
            raise ConnectionError("Not connected")
        self.mkt_data_requests.append((contract, genericTickList))
        if contract.conId in self._req_ids:
            self._orphans += 1
        self._req_ids[contract.conId] = next(self._reqs)
        existing = self._tickers.get(contract.conId)
        if existing is None:
            existing = self._new_ticker(contract)
            self._tickers[contract.conId] = existing
        return existing

    def cancelMktData(self, contract) -> bool:
        self.cancelled.append(contract)
        self._tickers.pop(contract.conId, None)
        return self._req_ids.pop(contract.conId, None) is not None

    async def qualifyContractsAsync(self, *contracts, returnAll=False):
        if self.qualify_gate is not None:
            drops = self._drops
            await self.qualify_gate.wait()
            if self._drops != drops:
                raise ConnectionError("Socket disconnect")
        if self.qualify_error is not None:
            raise self.qualify_error
        if self.qualify_delay:
            await asyncio.sleep(self.qualify_delay)
        return [self._qualify(c) for c in contracts]

    async def reqContractDetailsAsync(self, contract):
        if self.details_delay:
            await asyncio.sleep(self.details_delay)
        return [
            d for d in self.details
            if d.contract.symbol == contract.symbol
            and d.contract.lastTradeDateOrContractMonth == contract.lastTradeDateOrContractMonth
            and d.contract.tradingClass == contract.tradingClass
            and d.contract.multiplier == contract.multiplier
        ]

    async def reqSecDefOptParamsAsync(self, underlyingSymbol, futFopExchange,
                                      underlyingSecType, underlyingConId):
        return [c for c in self.chains if c.underlyingConId == underlyingConId]

    # -- test controls -------------------------------------------------------
    @property
    def open_lines(self) -> int:
        return len(self._req_ids) + self._orphans

    def tick(self, contract: dict, **fields) -> None:
        """A tick for an open subscription. Raises when there is none, so a test
        cannot pass by ticking a stream that was never opened."""
        for con_id in self._req_ids:
            t = self._tickers[con_id]
            c = t.contract
            if (c.strike, c.right, c.lastTradeDateOrContractMonth, c.tradingClass) == (
                float(contract["strike"]), contract["right"], contract["expiry"],
                contract["trading_class"],
            ):
                _apply(t, **fields)
                return
        raise AssertionError(f"no open subscription for {contract}")

    def tick_underlying(self, symbol: str, **fields) -> None:
        for con_id in self._req_ids:
            t = self._tickers[con_id]
            if t.contract.symbol == symbol and t.contract.secType != "OPT":
                _apply(t, **fields)
                return
        raise AssertionError(f"no open subscription for {symbol}")

    def disconnect(self) -> None:
        """`IB.disconnect`: closes the socket the way a drop does, and counts the call."""
        self.disconnect_calls = getattr(self, "disconnect_calls", 0) + 1
        self.drop()

    def drop(self) -> None:
        """The socket closes: ib_async's wrapper.connectionClosed fails pending
        requests and forgets all subscriptions."""
        self._connected = False
        self._req_ids.clear()
        self._tickers.clear()
        self._orphans = 0
        self._drops += 1
        if self.qualify_gate is not None:
            self.qualify_gate.set()
            self.qualify_gate = None

    def con_id(self, contract) -> int:
        return self._known.setdefault(_identity(contract), next(self._con_ids))

    def add_details(self, contract) -> None:
        self.details.append(ContractDetails(contract=contract))

    def _qualify(self, contract):
        is_unknown = (contract.symbol,) in self.unknown or (
            contract.symbol, contract.strike, contract.right) in self.unknown
        if is_unknown:
            return None
        if (contract.symbol, contract.strike, contract.right) in self.left_unqualified:
            return contract
        contract.conId = self.con_id(contract)
        return contract

    def _new_ticker(self, contract) -> Ticker:
        preset = self.quotes.get((contract.strike, contract.right))
        if preset is not None:
            return _copy_quote(ticker(**preset), contract)
        if self._default is not None:
            return _copy_quote(self._default, contract)
        return Ticker(contract=contract)
