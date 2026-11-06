"""Shared helpers for the IBKR tests."""
import asyncio

from ib_async import Option

from contracts import resolve
from ibkr import IbkrSource, MarketDataIB

SPX = resolve("SPX")
SPY = resolve("SPY")
EXPIRY = "20261112"
NAN = float("nan")
LOST_DATA = "Connectivity between IB and TWS has been restored - data lost."
KEPT_DATA = "Connectivity between IB and TWS has been restored - data maintained."


class Clock:
    """Reads advance by `step`, so wait loops end without real time passing."""

    def __init__(self, t=0.0, step=0.0):
        self.t = t
        self.step = step

    def __call__(self):
        now = self.t
        self.t += self.step
        return now


def source(fake, clock=None):
    return IbkrSource(fake, clock=clock or Clock(step=0.5))


def contract(strike, right, expiry=EXPIRY, trading_class="SPXW", symbol="SPX"):
    return {"symbol": symbol, "expiry": expiry, "strike": strike, "right": right,
            "trading_class": trading_class}


def contracts(n):
    return [contract(5000 + i, "C") for i in range(n)]


def option_details(strike, expiry=EXPIRY, trading_class="SPXW", multiplier="100"):
    return Option("SPX", expiry, strike, "C", "SMART", multiplier, "USD",
                  tradingClass=trading_class)


async def bounded(awaitable):
    """Fails rather than hangs if something that must not block does."""
    return await asyncio.wait_for(awaitable, 1)


async def eventually(condition):
    async def poll():
        while not condition():
            await asyncio.sleep(0)

    await bounded(poll())


class Session:
    """An IbkrSource on a real MarketDataIB. Qualification is answered locally;
    ticks go through the real wrapper."""

    def __init__(self, clock):
        self.ib = MarketDataIB()
        self.ib.qualifyContractsAsync = self._qualify
        self.source = IbkrSource(self.ib, clock=clock, host="127.0.0.1", port=7496, client_id=17)
        self._con_ids = {}

    async def _qualify(self, *contracts):
        for c in contracts:
            c.conId = self._con_ids.setdefault((c.symbol, c.strike, c.right),
                                               1000 + len(self._con_ids))
        return list(contracts)

    @property
    def lines(self):
        return dict(self.ib.wrapper.ticker2ReqId["mktData"])

    def tick(self, bid):
        for req_id in self.lines.values():
            self.ib.wrapper.priceSizeTick(req_id, 1, bid, 1.0)
            self.ib.wrapper.priceSizeTick(req_id, 2, bid + 1, 1.0)
            self.ib.wrapper.tickOptionComputation(req_id, 13, 0, 0.2, 0.5, -1, -1, -2, -2, -2, -1)
        self.ib.wrapper.tcpDataProcessed()


async def session(clock=None):
    live = Session(clock or Clock())
    assert await live.source.connect_once() is True
    return live
