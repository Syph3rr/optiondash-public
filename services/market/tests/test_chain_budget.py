"""A chain's IBKR share of time has to add up: strikes, qualifying and the snapshot together
stay inside IBKR_CHAIN_BUDGET, and running out returns the rows in hand."""
import asyncio
import time
from datetime import datetime, timezone

import pytest

import ibkr as ibkr_module
import router as router_module
from fake_ib import FakeIB, ticker
from ibkr_support import EXPIRY, SPX, Clock, bounded, contract, eventually, option_details, source
from router import Router

NOW = datetime(2026, 11, 2, 14, 0, tzinfo=timezone.utc)
ARGS = {"symbol": "SPX", "expiry": EXPIRY, "trading_class": "SPXW", "spot": 7580.0}
YAHOO_ROW = {"bid": 10.0, "ask": 11.0, "last": 10.4, "mark": 10.5, "mark_kind": "mid",
             "as_of": "2026-11-02T13:58:00Z"}
UNSETTLED = dict(bid=1.0, ask=2.0)  # no delta, so a snapshot waits as long as it may


class StubYahoo:
    def __init__(self):
        self.chain_calls = 0

    def chain(self, u, expiry, trading_class):
        self.chain_calls += 1
        return {(7580.0, "C"): YAHOO_ROW, (7580.0, "P"): YAHOO_ROW}


class TimedIbkr:
    """Takes `strikes_seconds` over the strikes and records the snapshot's allowance."""
    connected = True

    def __init__(self, strikes_seconds):
        self.strikes_seconds = strikes_seconds
        self.waits = []

    async def strikes(self, u, expiry, trading_class):
        await asyncio.sleep(self.strikes_seconds)
        return [7580.0]

    async def snapshot(self, u, expiry, trading_class, strikes, wait=6.0):
        self.waits.append(wait)
        return {}


def test_the_margin_leaves_time_inside_the_budget():
    assert 0 < router_module.IBKR_CHAIN_MARGIN < router_module.IBKR_CHAIN_BUDGET


async def test_snapshot_gets_the_remaining_budget_less_the_margin(monkeypatch):
    monkeypatch.setattr(router_module, "IBKR_CHAIN_BUDGET", 1.0)
    monkeypatch.setattr(router_module, "IBKR_CHAIN_MARGIN", 0.3)
    ibkr = TimedIbkr(strikes_seconds=0.2)

    await Router(ibkr, StubYahoo(), now=lambda: NOW).handle("chain", ARGS)

    [wait] = ibkr.waits
    assert 0.4 < wait <= 0.5


async def test_snapshot_allowance_is_never_negative(monkeypatch):
    monkeypatch.setattr(router_module, "IBKR_CHAIN_BUDGET", 0.1)
    monkeypatch.setattr(router_module, "IBKR_CHAIN_MARGIN", 0.09)
    ibkr = TimedIbkr(strikes_seconds=0.05)

    await Router(ibkr, StubYahoo(), now=lambda: NOW).handle("chain", ARGS)

    assert ibkr.waits == [0.0]


async def test_slow_strikes_and_qualify_keep_healthy_ibkr_rows(monkeypatch):
    """Strikes 3.5 s and qualify 2.7 s against the real 12 s budget, at a tenth of the time."""
    monkeypatch.setattr(router_module, "IBKR_CHAIN_BUDGET", 1.2)
    monkeypatch.setattr(router_module, "IBKR_CHAIN_MARGIN", 0.1)
    fake = FakeIB(ticker(**UNSETTLED))
    fake.add_details(option_details(7580.0))
    fake.details_delay, fake.qualify_delay = 0.35, 0.27
    yahoo = StubYahoo()
    router = Router(source(fake, time.monotonic), yahoo, now=lambda: NOW)

    out = await router.handle("chain", ARGS)

    assert [r["source"] for r in out["rows"]] == ["ibkr", "ibkr"]
    assert yahoo.chain_calls == 0
    assert fake.open_lines == 0


async def test_snapshot_wait_covers_qualifying_too():
    clock = Clock(step=0.1)
    fake = FakeIB(ticker(**UNSETTLED))
    answer = fake.qualifyContractsAsync

    async def qualify_taking_seconds(*contracts):
        clock.t += 2.7
        return await answer(*contracts)

    fake.qualifyContractsAsync = qualify_taking_seconds

    out = await source(fake, clock).snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=5.0)

    assert set(out) == {(7580.0, "C"), (7580.0, "P")}
    assert 5.0 <= clock.t <= 5.5


async def test_a_long_allowance_still_settles_for_no_more_than_the_usual_wait():
    clock = Clock(step=0.5)
    fake = FakeIB(ticker(**UNSETTLED))

    await source(fake, clock).snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=30.0)

    assert clock.t <= ibkr_module.SNAPSHOT_WAIT + 2


@pytest.fixture
def held_stream():
    """A leg already streaming at 7580, so a snapshot has that much whatever else happens."""
    fake = FakeIB(ticker(**UNSETTLED))
    return fake, contract(7580, "C")


async def test_a_qualify_timeout_returns_the_rows_in_hand(held_stream):
    fake, leg = held_stream
    s = source(fake)
    s.watch([leg])
    await eventually(lambda: fake.open_lines == 1)
    fake.qualify_error = TimeoutError()

    out = await bounded(s.snapshot(SPX, EXPIRY, "SPXW", [7580.0, 7600.0], wait=1.0))

    assert set(out) == {(7580.0, "C")}


async def test_running_out_of_time_while_qualifying_returns_the_rows_in_hand(held_stream):
    fake, leg = held_stream
    s = source(fake, time.monotonic)
    s.watch([leg])
    await eventually(lambda: fake.open_lines == 1)
    fake.qualify_gate = asyncio.Event()  # never answers

    out = await bounded(s.snapshot(SPX, EXPIRY, "SPXW", [7580.0, 7600.0], wait=0.05))

    assert set(out) == {(7580.0, "C")}
    assert fake.open_lines == 1  # the stream, and no line left behind
    assert s._lines_in_use() == 1
