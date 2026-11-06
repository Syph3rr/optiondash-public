"""TWS losing its own connection to IBKR while our socket stays up (R27). Every message goes
through the real `wrapper.error` on a real MarketDataIB; only the socket-level Client is
stubbed, so nothing here can reach TWS."""
import asyncio
from datetime import datetime, timezone

from ibkr import contract_key as key
from ibkr_support import EXPIRY, KEPT_DATA, LOST_DATA, SPX, Clock, bounded, contract, session
from router import Router

LOST_LINK = "Connectivity between IB and TWS has been lost."
LOST_REASON = "TWS lost its connection to IBKR"
NOW = datetime(2026, 11, 2, 14, 0, tzinfo=timezone.utc)
MARKET_DATA, CANCEL_MARKET_DATA = 1, 2
YAHOO_SPOT = {"price": 7499.0, "source": "yahoo", "data_type": "yahoo",
              "as_of": "2026-11-02T13:58:00Z"}
YAHOO_ROW = {"bid": 10.0, "ask": 11.0, "last": 10.4, "mark": 10.5, "mark_kind": "mid",
             "as_of": "2026-11-02T13:58:00Z"}


class StubYahoo:
    def spot(self, u):
        return YAHOO_SPOT

    def expiries(self, u):
        return []

    def chain(self, u, expiry, trading_class):
        return {(7580.0, "C"): YAHOO_ROW}


def link_lost(live):
    live.ib.wrapper.error(-1, 1100, LOST_LINK, "")


async def streaming(c, clock=None):
    """A session with spot and one leg streaming, and data on both."""
    live = await session(clock)
    await live.source.spot(SPX, wait=0)
    live.source.watch([c])
    live.tick(10.0)
    return live


async def settle():
    """Lets callbacks and spawned tasks run."""
    for _ in range(3):
        await asyncio.sleep(0)


def assert_serves_ibkr(source, c):
    assert source.connected is True
    assert source.offline_reason is None
    assert source.watch([c])[key(c)]["source"] == "ibkr"


async def test_1100_stops_every_read_while_the_socket_stays_up(wire):
    c = contract(7580, "C")
    live = await streaming(c)

    link_lost(live)

    assert live.ib.isConnected() is True
    assert live.source.watch([c])[key(c)] is None
    assert await bounded(live.source.spot(SPX)) is None
    assert await bounded(live.source.snapshot(SPX, EXPIRY, "SPXW", [7580.0])) == {}


async def test_1100_gives_the_reason_and_status_reports_it(wire):
    live = await streaming(contract(7580, "C"))
    router = Router(live.source, StubYahoo(), now=lambda: NOW)

    link_lost(live)

    assert live.source.connected is False
    assert LOST_REASON in live.source.offline_reason
    status = await router.handle("status", {})
    assert status["ibkr"] == "disconnected" and LOST_REASON in status["reason"]


async def test_1100_hands_quotes_and_spot_to_yahoo(wire):
    c = contract(7580, "C")
    live = await streaming(c)
    router = Router(live.source, StubYahoo(), now=lambda: NOW)
    before = await router.handle("quotes", {"symbol": "SPX", "contracts": [c]})
    assert before["quotes"][0]["source"] == "ibkr"

    link_lost(live)

    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [c]})
    assert out["underlying"] == YAHOO_SPOT
    assert (out["quotes"][0]["source"], out["quotes"][0]["mark"]) == ("yahoo", 10.5)


async def test_1100_sends_nothing_and_refuses_nothing(wire, caplog):
    live = await streaming(contract(7580, "C"))
    wire.sent.clear()

    link_lost(live)
    await settle()

    assert wire.sent == []
    assert wire.calls == []
    assert "refused" not in caplog.text


async def test_reads_open_no_new_stream_while_the_link_is_down(wire):
    live = await streaming(contract(7580, "C"))
    link_lost(live)
    wire.sent.clear()
    other = contract(7600, "C")

    assert live.source.watch([other])[key(other)] is None

    assert wire.sent == []


async def test_1101_clears_it_and_rebuilds_the_streams(wire):
    c = contract(7580, "C")
    live = await streaming(c)
    link_lost(live)
    wire.sent.clear()

    live.ib.wrapper.error(-1, 1101, LOST_DATA, "")

    assert [fields[0] for fields in wire.sent] == [CANCEL_MARKET_DATA, MARKET_DATA] * 2
    assert live.source.connected is True and live.source.offline_reason is None
    assert live.source.watch([c])[key(c)] is None  # nothing from before the loss
    live.tick(20.0)
    assert live.source.watch([c])[key(c)]["bid"] == 20.0


async def test_1102_clears_it_and_keeps_the_streams(wire):
    c = contract(7580, "C")
    live = await streaming(c)
    link_lost(live)
    wire.sent.clear()

    live.ib.wrapper.error(-1, 1102, KEPT_DATA, "")
    await settle()

    assert wire.sent == []
    assert_serves_ibkr(live.source, c)
    assert live.source.watch([c])[key(c)]["bid"] == 10.0


async def test_a_farm_message_neither_sets_nor_clears_it(wire):
    c = contract(7580, "C")
    live = await streaming(c)

    live.ib.wrapper.error(-1, 2103, "Market data farm connection is broken:usfarm", "")
    assert_serves_ibkr(live.source, c)

    link_lost(live)
    live.ib.wrapper.error(-1, 2104, "Market data farm connection is OK:usfarm", "")
    assert live.source.connected is False


async def test_the_startup_connect_leaves_a_live_socket_alone(wire):
    live = await streaming(contract(7580, "C"))
    link_lost(live)
    attempts = []

    async def no_reconnect():
        attempts.append(1)

    live.source.connect_once = no_reconnect
    task = asyncio.create_task(live.source.run_forever())
    await settle()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert attempts == []


async def test_a_stream_pruned_while_the_link_is_down_frees_its_line(wire):
    clock = Clock()
    live = await streaming(contract(7580, "C"), clock)
    link_lost(live)
    wire.sent.clear()

    clock.t = 60
    live.source.prune()

    assert [fields[0] for fields in wire.sent] == [CANCEL_MARKET_DATA] * 2
    assert live.lines == {}


async def test_a_stream_qualified_while_the_link_is_down_still_recovers(wire):
    c = contract(7580, "C")
    live = await session()
    gate = asyncio.Event()
    answer = live.ib.qualifyContractsAsync

    async def held(*contracts):
        await gate.wait()
        return await answer(*contracts)

    live.ib.qualifyContractsAsync = held
    live.source.watch([c])
    await settle()
    link_lost(live)
    gate.set()
    await settle()

    live.ib.wrapper.error(-1, 1102, KEPT_DATA, "")
    live.tick(30.0)

    assert live.source.watch([c])[key(c)]["bid"] == 30.0


async def test_a_snapshot_cut_short_by_1100_releases_its_lines(wire):
    live = await session()
    task = asyncio.create_task(live.source.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=1.0))
    await settle()
    assert len(live.lines) == 2

    link_lost(live)

    assert await bounded(task) == {}
    assert live.lines == {}


async def test_a_new_socket_session_starts_clear(wire):
    c = contract(7580, "C")
    live = await streaming(c)
    link_lost(live)
    live.ib.disconnect()
    assert LOST_REASON not in live.source.offline_reason

    assert await bounded(live.source.connect_once()) is True

    assert live.source.connected is True
    assert live.source.watch([c])[key(c)] is None  # fresh tickers, so nothing frozen
    live.tick(40.0)
    assert_serves_ibkr(live.source, c)


async def test_a_1100_during_the_handshake_is_kept(wire):
    live = await session()
    live.ib.disconnect()
    connect = live.ib.connectAsync

    async def lost_during_connect(*args, **kwargs):
        link_lost(live)
        return await connect(*args, **kwargs)

    live.ib.connectAsync = lost_during_connect
    assert await bounded(live.source.connect_once()) is True

    assert live.source.connected is False
    assert LOST_REASON in live.source.offline_reason
