import asyncio
import math

import pytest

from fake_ib import FakeIB, ticker
from ibkr import contract_key as key
from ibkr_support import (
    EXPIRY, NAN, SPX, SPY, Clock, bounded, contract, contracts, eventually, source,
)


# -- watch --------------------------------------------------------------------
async def test_watch_never_blocks_and_fills_after_first_tick():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    assert s.watch([c])[key(c)] is None
    fake.tick(c, bid=98.2, ask=99.9)
    assert s.watch([c])[key(c)]["mark"] == 99.05


async def test_watch_returns_while_qualification_is_still_pending():
    s = source(fake := FakeIB())
    fake.qualify_gate = asyncio.Event()
    c = contract(7580, "C")

    assert s.watch([c]) == {(7580.0, "C", EXPIRY, "SPXW"): None}
    assert s.watch([c]) == {(7580.0, "C", EXPIRY, "SPXW"): None}
    assert fake.mkt_data_requests == []

    fake.qualify_gate.set()
    await eventually(lambda: fake.mkt_data_requests)
    fake.tick(c, last=99.2)
    assert s.watch([c])[key(c)]["mark"] == 99.2
    assert len(fake.mkt_data_requests) == 1


async def test_watch_row_has_every_field():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=98.2, ask=99.9, last=99.2, md_type=4, iv=0.1624, delta=0.526)
    assert s.watch([c])[key(c)] == {
        "bid": 98.2, "ask": 99.9, "last": 99.2, "mark": 99.05, "mark_kind": "mid",
        "delta": 0.526, "ibkr_iv": 0.1624, "data_type": "delayed_frozen",
        "source": "ibkr", "as_of": "2026-11-01T11:00:00Z",
    }


async def test_watch_row_shows_the_type_actually_delivered():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=98.2, ask=99.9, md_type=1)
    assert s.watch([c])[key(c)]["data_type"] == "live"


async def test_watch_requests_generic_ticks_on_a_qualified_option():
    s = source(fake := FakeIB())
    s.watch([contract(7580, "C")])
    option, generic = fake.mkt_data_requests[0]
    assert generic == "101,106"
    assert (option.secType, option.symbol, option.lastTradeDateOrContractMonth, option.strike,
            option.right, option.exchange, option.currency, option.tradingClass,
            option.multiplier) == (
        "OPT", "SPX", EXPIRY, 7580.0, "C", "SMART", "USD", "SPXW", "100")


async def test_contract_key_is_stable_across_strike_types():
    assert key(contract(7580, "C")) == (7580.0, "C", EXPIRY, "SPXW")
    assert key(contract(7580.0, "C")) == key(contract(7580, "C"))


async def test_put_delta_stays_negative():
    s = source(fake := FakeIB()); c = contract(7580, "P")
    s.watch([c])
    fake.tick(c, bid=90.0, ask=91.0, iv=0.17, delta=-0.474)
    assert s.watch([c])[key(c)]["delta"] == -0.474


@pytest.mark.parametrize("bad", [NAN, math.inf, -2.0, 1.5])
async def test_impossible_delta_is_dropped(bad):
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=90.0, ask=91.0, delta=bad)
    assert s.watch([c])[key(c)]["delta"] is None


@pytest.mark.parametrize("bad", [NAN, -1.0, 0.0])
async def test_impossible_iv_is_dropped(bad):
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=90.0, ask=91.0, iv=bad, delta=0.5)
    assert s.watch([c])[key(c)]["ibkr_iv"] is None


async def test_row_without_model_greeks_still_has_a_mark():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=90.0, ask=91.0)
    row = s.watch([c])[key(c)]
    assert (row["mark"], row["delta"], row["ibkr_iv"]) == (90.5, None, None)


async def test_row_never_takes_a_mark_from_close():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=95.0, close=120.0)
    row = s.watch([c])[key(c)]
    assert (row["bid"], row["mark"], row["mark_kind"]) == (95.0, None, None)


async def test_crossed_market_falls_back_to_last():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=100.0, ask=99.0, last=99.5)
    row = s.watch([c])[key(c)]
    assert (row["mark"], row["mark_kind"]) == (99.5, "last")


async def test_all_nan_tickers_count_as_no_data():
    fake = FakeIB(ticker(bid=-1, ask=-1, last=NAN, close=7720.39, iv=0.16, delta=0.5))
    s = source(fake)
    c = contract(7580, "C")
    fake.quotes[(7580.0, "C")] = dict(bid=-1, ask=NAN, last=NAN, close=7720.39)
    s.watch([c])
    assert s.watch([c])[key(c)] is None
    assert await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0) == {}
    assert await source(FakeIB(ticker(bid=-1, ask=-1))).spot(SPX) is None


async def test_watch_does_not_resubscribe():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    s.watch([c])
    s.watch([contract(7580.0, "C")])
    assert len(fake.mkt_data_requests) == 1
    assert fake.open_lines == 1


async def test_line_budget_caps_at_60():
    s = source(fake := FakeIB())
    wanted = contracts(70)
    out = s.watch(wanted)
    assert len(fake.mkt_data_requests) == 60
    assert fake.open_lines == 60
    assert set(out) == {key(c) for c in wanted}

    s.watch(wanted)
    assert len(fake.mkt_data_requests) == 60


async def test_budget_counts_lines_still_qualifying():
    s = source(fake := FakeIB())
    fake.qualify_gate = asyncio.Event()
    s.watch(contracts(70))
    fake.qualify_gate.set()
    await eventually(lambda: len(fake.mkt_data_requests) >= 60)
    await asyncio.sleep(0)
    assert len(fake.mkt_data_requests) == 60


async def test_budget_includes_spot_streams():
    fake = FakeIB(ticker(last=7580.95))
    s = source(fake)
    await s.spot(SPX)
    await s.spot(SPY)
    s.watch(contracts(60))
    assert fake.open_lines == 60


async def test_budget_includes_lines_held_by_a_snapshot():
    fake = FakeIB()
    s = source(fake, Clock())
    strikes = [5000.0 + i for i in range(25)]
    task = asyncio.create_task(s.snapshot(SPX, EXPIRY, "SPXW", strikes))
    await eventually(lambda: fake.open_lines >= 50)
    s.watch([contract(6000 + i, "C") for i in range(20)])
    assert fake.open_lines == 60
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert fake.open_lines == 10


async def test_failed_qualification_is_skipped():
    s = source(fake := FakeIB())
    fake.unknown.add(("SPX", 756.0, "C"))
    bad, good = contract(756, "C"), contract(7580, "C")

    assert s.watch([bad, good]) == {key(bad): None, key(good): None}

    assert [c.strike for c, _ in fake.mkt_data_requests] == [7580.0]
    assert fake.open_lines == 1
    fake.tick(good, last=99.2)
    assert s.watch([bad, good])[key(good)]["mark"] == 99.2


async def test_entry_returned_without_a_con_id_is_skipped():
    s = source(fake := FakeIB())
    fake.left_unqualified.add(("SPY", 756.0, "C"))
    bad = contract(756, "C", trading_class="SPY", symbol="SPY")

    assert s.watch([bad]) == {key(bad): None}

    assert fake.mkt_data_requests == []
    assert fake.open_lines == 0


async def test_snapshot_skips_an_entry_returned_without_a_con_id():
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    fake.left_unqualified.add(("SPY", 756.0, "C"))
    out = await source(fake).snapshot(SPY, EXPIRY, "SPY", [756.0], wait=1.0)
    assert set(out) == {(756.0, "P")}
    assert fake.open_lines == 0


async def test_failed_qualification_frees_its_line():
    s = source(fake := FakeIB())
    fake.unknown.add(("SPX", 756.0, "C"))
    s.watch([contract(756, "C")])
    s.watch(contracts(60))
    assert fake.open_lines == 60


async def test_failed_qualification_retries_only_after_a_minute():
    fake = FakeIB()
    clock = Clock()
    s = source(fake, clock)
    fake.unknown.add(("SPX", 756.0, "C"))
    c = contract(756, "C")
    calls = []
    original = fake.qualifyContractsAsync

    async def counting(*args):
        calls.append(args)
        return await original(*args)

    fake.qualifyContractsAsync = counting
    s.watch([c])
    clock.t = 59
    s.watch([c])
    assert len(calls) == 1
    clock.t = 60
    s.watch([c])
    assert len(calls) == 2


async def test_qualification_error_frees_the_line_and_stays_retryable():
    s = source(fake := FakeIB())
    fake.qualify_error = ConnectionError("Socket disconnect")
    c = contract(7580, "C")
    assert s.watch([c])[key(c)] is None
    fake.qualify_error = None
    s.watch([c])
    assert len(fake.mkt_data_requests) == 1


async def test_watch_reads_nothing_while_disconnected():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=98.2, ask=99.9)
    fake.drop()
    assert s.watch([c])[key(c)] is None
    assert s.watch([contract(7600, "C")]) == {(7600.0, "C", EXPIRY, "SPXW"): None}
    assert len(fake.mkt_data_requests) == 1


# -- snapshot -----------------------------------------------------------------
async def test_snapshot_returns_rows_keyed_by_strike_and_right():
    fake = FakeIB()
    fake.quotes[(7580.0, "C")] = dict(bid=98.2, ask=99.9, last=99.2, iv=0.1624, delta=0.526)
    fake.quotes[(7580.0, "P")] = dict(bid=90.0, ask=91.0, iv=0.17, delta=-0.474)
    assert await source(fake).snapshot(SPX, EXPIRY, "SPXW", [7580.0]) == {
        (7580.0, "C"): {
            "bid": 98.2, "ask": 99.9, "last": 99.2, "mark": 99.05, "mark_kind": "mid",
            "delta": 0.526, "ibkr_iv": 0.1624, "data_type": "delayed_frozen",
            "source": "ibkr", "as_of": "2026-11-01T11:00:00Z",
        },
        (7580.0, "P"): {
            "bid": 90.0, "ask": 91.0, "last": None, "mark": 90.5, "mark_kind": "mid",
            "delta": -0.474, "ibkr_iv": 0.17, "data_type": "delayed_frozen",
            "source": "ibkr", "as_of": "2026-11-01T11:00:00Z",
        },
    }


async def test_snapshot_ends_early_when_every_line_has_data():
    fake = FakeIB(ticker(bid=1.0, ask=2.0, iv=0.2, delta=0.5))
    clock = Clock(step=0.5)
    await source(fake, clock).snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=6.0)
    assert clock.t <= 1.5  # three clock reads to set the deadlines, and no waiting


async def test_snapshot_waits_out_a_line_with_no_data():
    fake = FakeIB()
    fake.quotes[(7580.0, "C")] = dict(bid=1.0, ask=2.0, iv=0.2, delta=0.5)
    clock = Clock(step=0.5)
    out = await source(fake, clock).snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=6.0)
    assert set(out) == {(7580.0, "C")}
    assert 6.0 <= clock.t <= 8.0


async def test_snapshot_releases_its_lines():
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    await source(fake).snapshot(SPX, EXPIRY, "SPXW", [7575.0, 7580.0], wait=1.0)
    assert len(fake.mkt_data_requests) == 4
    assert len(fake.cancelled) == 4
    assert fake.open_lines == 0


async def test_snapshot_releases_its_lines_when_cancelled():
    fake = FakeIB()
    s = source(fake, Clock())
    task = asyncio.create_task(s.snapshot(SPX, EXPIRY, "SPXW", [7580.0]))
    await eventually(lambda: fake.open_lines >= 2)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert fake.open_lines == 0
    s.watch(contracts(60))
    assert fake.open_lines == 60


async def test_snapshot_returns_only_what_the_budget_allows_nearest_first():
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    s = source(fake)
    s.watch(contracts(54))
    strikes = [7550.0, 7555.0, 7560.0, 7565.0, 7570.0, 7575.0, 7580.0]

    out = await s.snapshot(SPX, EXPIRY, "SPXW", strikes, wait=1.0)

    # 6 free lines cover 3 strikes. The window is sorted and centred on spot,
    # so the middle three are the nearest.
    assert set(out) == {
        (7560.0, "C"), (7560.0, "P"), (7565.0, "C"), (7565.0, "P"),
        (7570.0, "C"), (7570.0, "P"),
    }
    assert fake.open_lines == 54


async def test_snapshot_with_no_budget_left_returns_nothing():
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    s = source(fake)
    s.watch(contracts(60))
    assert await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0) == {}
    assert len(fake.mkt_data_requests) == 60


async def test_snapshot_skips_failed_qualification():
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    fake.unknown.add(("SPX", 756.0, "C"))
    out = await source(fake).snapshot(SPX, EXPIRY, "SPXW", [756.0], wait=1.0)
    assert set(out) == {(756.0, "P")}
    assert fake.open_lines == 0


async def test_snapshot_reads_an_open_leg_stream_and_leaves_it_open():
    s = source(fake := FakeIB(ticker(bid=1.0, ask=2.0)))
    c = contract(7580, "C")
    s.watch([c])

    out = await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=3.0)

    assert set(out) == {(7580.0, "C"), (7580.0, "P")}
    assert len(fake.mkt_data_requests) == 2     # the stream, and the put only
    assert fake.open_lines == 1
    fake.tick(c, bid=3.0, ask=4.0)
    assert s.watch([c])[key(c)]["mark"] == 3.5


async def test_watch_during_a_snapshot_waits_for_its_own_line():
    fake = FakeIB()
    s = source(fake, Clock())
    c = contract(7580, "C")
    task = asyncio.create_task(s.snapshot(SPX, EXPIRY, "SPXW", [7580.0]))
    await eventually(lambda: fake.open_lines >= 2)

    assert s.watch([c])[key(c)] is None
    assert len(fake.mkt_data_requests) == 2     # no second request for a held contract

    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert fake.open_lines == 0
    s.watch([c])
    assert fake.open_lines == 1


async def test_concurrent_snapshots_do_not_share_lines():
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    s = source(fake)
    a, b = await asyncio.gather(
        s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0),
        s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0),
    )
    assert set(a) == set(b) == {(7580.0, "C"), (7580.0, "P")}
    assert fake.open_lines == 0


async def test_snapshot_is_empty_while_disconnected():
    fake = FakeIB(connected=False)
    assert await source(fake).snapshot(SPX, EXPIRY, "SPXW", [7580.0]) == {}
    assert fake.mkt_data_requests == []


async def test_snapshot_stops_when_the_connection_drops():
    fake = FakeIB()
    s = source(fake, Clock())
    task = asyncio.create_task(s.snapshot(SPX, EXPIRY, "SPXW", [7580.0]))
    await eventually(lambda: fake.open_lines >= 2)
    fake.drop()
    assert await bounded(task) == {}
    assert fake.cancelled == []


# -- prune --------------------------------------------------------------------
async def test_prune_drops_streams_idle_for_60_seconds():
    clock = Clock()
    fake = FakeIB()
    s = source(fake, clock)
    stale, kept = contract(7580, "C"), contract(7600, "C")
    s.watch([stale, kept])

    clock.t = 30
    s.watch([kept])
    clock.t = 59.9
    s.prune()
    assert fake.open_lines == 2

    clock.t = 60
    s.prune()
    assert [c.strike for c in fake.cancelled] == [7580.0]
    assert fake.open_lines == 1

    fake.tick(kept, last=5.0)
    assert s.watch([kept])[key(kept)]["mark"] == 5.0


async def test_pruned_stream_frees_budget_and_reopens():
    clock = Clock()
    fake = FakeIB()
    s = source(fake, clock)
    wanted = contracts(60)
    s.watch(wanted)
    clock.t = 60
    s.prune()
    assert fake.open_lines == 0
    s.watch(wanted[:1])
    assert fake.open_lines == 1
    assert len(fake.mkt_data_requests) == 61


async def test_prune_covers_spot_streams_and_a_read_keeps_them():
    clock = Clock()
    fake = FakeIB(ticker(last=7580.95))
    s = source(fake, clock)
    await s.spot(SPX, wait=0)
    clock.t = 40
    await s.spot(SPX, wait=0)
    clock.t = 80
    s.prune()
    assert fake.open_lines == 1
    clock.t = 100
    s.prune()
    assert fake.open_lines == 0


async def test_prune_while_disconnected_forgets_without_cancelling():
    clock = Clock()
    fake = FakeIB()
    s = source(fake, clock)
    s.watch([contract(7580, "C")])
    fake.drop()
    clock.t = 60
    s.prune()
    assert fake.cancelled == []
    await s.connect_once()
    assert fake.open_lines == 0


async def test_prune_during_qualification_abandons_the_stream():
    clock = Clock()
    fake = FakeIB()
    s = source(fake, clock)
    fake.qualify_gate = asyncio.Event()
    s.watch([contract(7580, "C")])
    clock.t = 60
    s.prune()
    fake.qualify_gate.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert fake.mkt_data_requests == []


# -- reconnect ----------------------------------------------------------------
async def test_reconnect_rebuilds_subscriptions():
    fake = FakeIB(ticker(last=7580.95))
    s = source(fake)
    c = contract(7580, "C")
    await s.spot(SPX)
    s.watch([c])
    fake.tick(c, bid=98.2, ask=99.9)

    fake.drop()
    assert s.connected is False
    assert fake.open_lines == 0

    assert await s.connect_once() is True
    assert fake.open_lines == 2
    assert s.watch([c])[key(c)]["mark"] == 7580.95      # the new ticker's data, not the old
    fake.tick(c, bid=100.0, ask=102.0)
    assert s.watch([c])[key(c)]["mark"] == 101.0
    fake.tick_underlying("SPX", last=7600.0)
    assert (await s.spot(SPX))["price"] == 7600.0
    assert [g for _, g in fake.mkt_data_requests[-2:]] == ["", "101,106"]


async def test_stale_ticker_is_not_served_after_reconnect():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=98.2, ask=99.9)
    fake.drop()
    await s.connect_once()
    assert s.watch([c])[key(c)] is None


async def test_failed_reconnect_keeps_streams_for_the_next_cycle():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    s.watch([c])
    fake.drop()
    fake.refuse_connections = True
    assert await s.connect_once() is False
    fake.refuse_connections = False
    assert await s.connect_once() is True
    assert fake.open_lines == 1


async def test_stream_still_qualifying_when_the_socket_drops_reopens_once():
    s = source(fake := FakeIB())
    fake.qualify_gate = asyncio.Event()
    c = contract(7580, "C")
    s.watch([c])

    fake.drop()                     # the real library fails the pending request
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert fake.mkt_data_requests == []

    await s.connect_once()
    assert fake.open_lines == 0
    s.watch([c])
    assert fake.open_lines == 1


async def test_a_dropped_qualification_frees_its_line():
    s = source(fake := FakeIB())
    fake.qualify_gate = asyncio.Event()
    s.watch(contracts(60))
    fake.drop()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    await s.connect_once()

    s.watch(contracts(60))

    assert fake.open_lines == 60


# -- a request that raises ----------------------------------------------------
class FlakyRequests:
    """Fails `reqMktData` until healed, as the library does on a broken send."""

    def __init__(self, fake, fails_for=None):
        self._real = fake.reqMktData
        self._fails_for = fails_for
        self.healed = False
        fake.reqMktData = self

    def __call__(self, contract, *args):
        if not self.healed and self._fails_for in (None, contract.strike):
            raise RuntimeError("boom")
        return self._real(contract, *args)


async def test_failed_request_frees_its_line_and_retries():
    s = source(fake := FakeIB()); c = contract(7580, "C")
    flaky = FlakyRequests(fake)

    assert s.watch([c])[key(c)] is None

    flaky.healed = True
    s.watch([c])
    assert fake.open_lines == 1
    fake.tick(c, last=99.2)
    assert s.watch([c])[key(c)]["mark"] == 99.2


async def test_failed_requests_do_not_use_up_the_budget():
    s = source(fake := FakeIB())
    flaky = FlakyRequests(fake)
    s.watch(contracts(60))
    flaky.healed = True

    s.watch(contracts(60))

    assert fake.open_lines == 60


async def test_failed_rebuild_of_one_stream_does_not_stop_the_others():
    s = source(fake := FakeIB())
    bad, good = contract(7580, "C"), contract(7600, "C")
    s.watch([bad, good])
    fake.drop()
    flaky = FlakyRequests(fake, fails_for=7580.0)

    assert await s.connect_once() is True

    assert fake.open_lines == 1
    fake.tick(good, last=5.0)
    assert s.watch([good])[key(good)]["mark"] == 5.0
    flaky.healed = True
    s.watch([bad])
    assert fake.open_lines == 2


# -- a repeated request gets a new ticker -------------------------------------
async def test_second_snapshot_never_returns_the_first_ones_quotes():
    fake = FakeIB()
    fake.quotes[(7580.0, "C")] = dict(bid=10.0, ask=11.0, iv=0.2, delta=0.5)
    s = source(fake)
    first = await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0)
    assert first[(7580.0, "C")]["bid"] == 10.0

    fake.quotes[(7580.0, "C")] = dict(bid=20.0, ask=21.0, iv=0.2, delta=0.5)
    second = await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0)
    assert second[(7580.0, "C")]["bid"] == 20.0

    fake.quotes.clear()
    assert await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0) == {}


async def test_reopened_watch_never_returns_values_from_before():
    clock = Clock()
    s = source(fake := FakeIB(), clock); c = contract(7580, "C")
    s.watch([c])
    fake.tick(c, bid=10.0, ask=11.0)
    clock.t = 60
    s.prune()

    assert s.watch([c])[key(c)] is None


async def test_reopened_spot_never_returns_values_from_before():
    clock = Clock()
    s = source(fake := FakeIB(), clock)
    await s.spot(SPX, wait=0)
    fake.tick_underlying("SPX", last=7580.95)
    clock.t = 60
    s.prune()

    assert await s.spot(SPX, wait=0) is None


# -- connectivity messages ----------------------------------------------------
async def test_error_1101_rebuilds_every_stream_within_the_budget():
    fake = FakeIB(ticker(last=7580.95))
    s = source(fake)
    await s.spot(SPX)
    s.watch(contracts(59))
    assert fake.open_lines == 60
    requests = len(fake.mkt_data_requests)

    fake.errorEvent.emit(-1, 1101, "restored, data lost", None)

    assert fake.open_lines == 60
    assert len(fake.cancelled) == 60
    assert len(fake.mkt_data_requests) == requests + 60
    assert len({c.conId for c, _ in fake.mkt_data_requests[requests:]}) == 60


async def test_error_1101_keeps_each_streams_generic_ticks():
    fake = FakeIB(ticker(last=7580.95))
    s = source(fake)
    await s.spot(SPX)
    s.watch([contract(7580, "C")])
    requests = len(fake.mkt_data_requests)

    fake.errorEvent.emit(-1, 1101, "restored, data lost", None)

    assert [g for _, g in fake.mkt_data_requests[requests:]] == ["", "101,106"]


async def test_error_1101_with_a_failed_request_frees_that_line():
    s = source(fake := FakeIB())
    bad, good = contract(7580, "C"), contract(7600, "C")
    s.watch([bad, good])
    flaky = FlakyRequests(fake, fails_for=7580.0)

    fake.errorEvent.emit(-1, 1101, "restored, data lost", None)

    assert fake.open_lines == 1
    flaky.healed = True
    s.watch([bad])
    assert fake.open_lines == 2


async def test_error_1101_leaves_a_stream_still_qualifying_alone():
    s = source(fake := FakeIB())
    fake.qualify_gate = asyncio.Event()
    s.watch([contract(7580, "C")])

    fake.errorEvent.emit(-1, 1101, "restored, data lost", None)
    assert fake.cancelled == []

    fake.qualify_gate.set()
    await eventually(lambda: fake.mkt_data_requests)
    assert fake.open_lines == 1


async def test_error_1101_while_disconnected_does_nothing():
    s = source(fake := FakeIB())
    s.watch([contract(7580, "C")])
    fake.drop()
    requests = len(fake.mkt_data_requests)

    fake.errorEvent.emit(-1, 1101, "restored, data lost", None)

    assert fake.cancelled == []
    assert len(fake.mkt_data_requests) == requests
    await s.connect_once()
    assert fake.open_lines == 1     # the stream was kept for the rebuild


@pytest.mark.parametrize("code", [1100, 1102, 2104, 2106, 2158, 2119, 10168, 10089, 300])
async def test_other_messages_leave_streams_alone(code):
    s = source(fake := FakeIB())
    s.watch([contract(7580, "C")])

    fake.errorEvent.emit(-1, code, "status", None)

    assert fake.cancelled == []
    assert len(fake.mkt_data_requests) == 1


# -- snapshot and idle time ---------------------------------------------------
async def test_snapshot_read_counts_as_a_request_for_prune():
    clock = Clock()
    fake = FakeIB(ticker(bid=1.0, ask=2.0))
    s = source(fake, clock)
    s.watch([contract(7580, "C")])

    clock.t = 50
    await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=0)
    clock.t = 109
    s.prune()
    assert fake.open_lines == 1

    clock.t = 110
    s.prune()
    assert fake.open_lines == 0
