"""The real ib_async `IB` and `Wrapper`, with only the socket-level `Client` calls
stubbed: no TWS, and no socket is ever opened. These cover what leaves the client
and how the library's own state behaves, which FakeIB can only imitate."""
import asyncio
import inspect
import logging
import re

import pytest
from ib_async import IB, Option
from ib_async.client import Client
from ib_async.ib import StartupFetchALL, StartupFetchNONE

from ibkr import BlockedRequest, BrokerIB, IbkrSource, MarketDataIB, contract_key as key
from ibkr_support import (
    EXPIRY, KEPT_DATA, LOST_DATA, SPX, Clock, bounded, contract, eventually, session,
)

SHORT = 0.01  # a stub never answers, so a plain IB waits this long per request

# The ruling's list, spelled out here so the test does not read it from production.
RULED_SENDS = (
    "reqAccountUpdates", "reqAccountUpdatesMulti",
    "reqOpenOrders", "reqAllOpenOrders", "reqAutoOpenOrders", "reqCompletedOrders",
    "placeOrder", "cancelOrder", "reqGlobalCancel", "reqPositionsMulti",
    "exerciseOptions", "reqPnL", "reqPnLSingle", "reqIds",
)
# Read on request by the broker, and never as a side effect of connecting.
ALLOWED_READS = ("reqExecutions", "reqPositions", "cancelPositions",
                 "reqAccountSummary", "cancelAccountSummary")
SUMMARY_TAGS = {"TotalCashValue", "NetLiquidation", "AvailableFunds", "BuyingPower"}
ORDER_SENDS = ("placeOrder", "cancelOrder", "reqGlobalCancel", "exerciseOptions",
               "reqOpenOrders", "reqAllOpenOrders", "reqCompletedOrders", "reqAutoOpenOrders")
NEUTRAL_REQUESTS = (
    "reqPositionsAsync", "reqAccountSummaryAsync", "accountSummaryAsync",
    "reqAccountUpdatesAsync", "reqAccountUpdatesMultiAsync", "reqOpenOrdersAsync",
    "reqAllOpenOrdersAsync", "reqCompletedOrdersAsync", "reqExecutionsAsync",
    "whatIfOrderAsync", "requestFAAsync", "reqUserInfoAsync",
)
SENSITIVE_SEND = re.compile(
    r"^(reqIds$|exercise|(req|cancel|place|request|replace).*"
    r"(order|account|accts|position|pnl|execution|fa$|globalcancel|softdollar"
    r"|familycodes|userinfo))",
    re.IGNORECASE,
)
MARKET_DATA, CANCEL_MARKET_DATA, ACCOUNT_SUMMARY, CANCEL_ACCOUNT_SUMMARY = 1, 2, 62, 63


async def read_only_connect(ib):
    return await bounded(ib.connectAsync(
        "127.0.0.1", 7496, clientId=17, timeout=SHORT, readonly=True,
        fetchFields=StartupFetchNONE))


def test_market_data_ib_is_the_broker_ib():
    assert MarketDataIB is BrokerIB


def test_market_data_ib_runs_the_library_connect_unchanged():
    assert MarketDataIB.connectAsync is IB.connectAsync


async def test_connect_sends_no_positions_request_and_completes(wire):
    ib = MarketDataIB()

    result = await read_only_connect(ib)

    assert result is ib
    assert ib.isConnected() is True
    assert "reqPositions" not in wire.calls


async def test_connect_sends_nothing_about_the_account(wire):
    await read_only_connect(MarketDataIB())

    assert wire.sent == []


async def test_connect_sends_nothing_even_when_asked_for_everything(wire):
    ib = MarketDataIB()

    await bounded(ib.connectAsync(
        "127.0.0.1", 7496, clientId=17, timeout=SHORT, readonly=False,
        fetchFields=StartupFetchALL))

    assert ib.isConnected() is True
    assert wire.sent == []


async def test_client_id_zero_on_the_guarded_ib_sends_nothing(wire):
    ib = MarketDataIB()

    await bounded(ib.connectAsync(
        "127.0.0.1", 7496, clientId=0, timeout=SHORT, readonly=True,
        fetchFields=StartupFetchNONE))

    assert ib.isConnected() is True
    assert wire.sent == []


@pytest.mark.parametrize("name", RULED_SENDS)
async def test_each_ruled_send_is_refused_and_logged(wire, caplog, name):
    ib = MarketDataIB()
    await read_only_connect(ib)
    arguments = len(inspect.signature(getattr(Client, name)).parameters) - 1

    with caplog.at_level(logging.ERROR, logger="sidecar.ibkr"):
        with pytest.raises(BlockedRequest):
            getattr(ib.client, name)(*[0] * arguments)

    assert wire.sent == []
    assert name in caplog.text


def test_every_account_or_order_send_in_the_library_is_refused():
    sends = [name for name, value in vars(Client).items()
             if inspect.isfunction(value) and SENSITIVE_SEND.match(name)]
    client = MarketDataIB().client

    assert set(RULED_SENDS) <= set(sends)
    assert set(ALLOWED_READS) <= set(sends)
    assert {"reqIds", "reqManagedAccts", "requestFA", "replaceFA"} <= set(sends)
    refused = [n for n in sends if getattr(client, n).__name__ == "refuse"]
    assert sorted(set(sends) - set(refused)) == sorted(ALLOWED_READS)
    assert set(ORDER_SENDS) <= set(refused)


@pytest.mark.parametrize("name", NEUTRAL_REQUESTS)
async def test_library_level_account_requests_finish_without_sending(wire, name):
    ib = MarketDataIB()
    await read_only_connect(ib)

    assert await bounded(getattr(ib, name)()) == []

    assert wire.sent == []


async def test_guard_survives_a_reconnect(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    ib.disconnect()
    await read_only_connect(ib)

    with pytest.raises(BlockedRequest):
        ib.client.placeOrder(0, None, None)
    assert wire.sent == []


async def test_a_direct_positions_request_stays_local(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)

    assert await bounded(ib.reqPositionsAsync()) == []

    assert wire.calls == []
    assert wire.sent == []


async def test_control_plain_ib_sends_positions_despite_startup_fetch_none(wire):
    """Why MarketDataIB exists. If an ib_async upgrade fails this, the library fixed
    the bug and MarketDataIB can go."""
    await read_only_connect(IB())

    assert wire.calls == ["reqPositions"]
    assert wire.sent == [(61, 1)]


async def test_control_the_wire_sees_every_account_request(wire):
    """Proves an empty `wire.calls` above is meaningful, not a blind spy."""
    await bounded(IB().connectAsync(
        "127.0.0.1", 7496, clientId=17, timeout=SHORT, readonly=False,
        fetchFields=StartupFetchALL))

    assert {"reqPositions", "reqAccountUpdates", "reqAccountUpdatesMulti", "reqOpenOrders",
            "reqCompletedOrders", "reqExecutions"} <= set(wire.calls)


async def test_default_source_connects_through_market_data_ib(wire):
    s = IbkrSource(host="127.0.0.1", port=7496, client_id=17)

    assert await bounded(s.connect_once()) is True

    assert s.connected is True
    assert wire.calls == []
    assert wire.sent == [(59, 1, 4)]    # reqMarketDataType(4), and nothing else


async def test_source_refuses_an_unguarded_ib():
    with pytest.raises(TypeError):
        IbkrSource(IB(), client_id=17)


# -- connectivity messages ----------------------------------------------------
async def test_error_1102_sends_nothing_and_keeps_streams(wire, caplog):
    live = await session()
    c = contract(7580, "C")
    live.source.watch([c])
    live.tick(10.0)
    wire.sent.clear()

    live.ib.wrapper.error(-1, 1102, KEPT_DATA, "")
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert wire.sent == []
    assert live.source.watch([c])[key(c)]["bid"] == 10.0
    assert "refused" not in caplog.text


async def test_control_plain_ib_requests_the_account_summary_on_1102(wire):
    """The bug MarketDataIB closes. A failure here means ib_async changed."""
    ib = IB()
    await read_only_connect(ib)
    wire.sent.clear()

    ib.wrapper.error(-1, 1102, KEPT_DATA, "")
    await asyncio.sleep(0)

    assert [fields[0] for fields in wire.sent] == [ACCOUNT_SUMMARY]


async def test_error_1101_cancels_and_requests_each_stream_once(wire):
    live = await session()
    legs = [contract(7580, "C"), contract(7600, "C")]
    await live.source.spot(SPX, wait=0)
    live.source.watch(legs)
    live.tick(10.0)
    before = live.lines
    wire.sent.clear()

    live.ib.wrapper.error(-1, 1101, LOST_DATA, "")

    assert [fields[0] for fields in wire.sent] == [CANCEL_MARKET_DATA, MARKET_DATA] * 3
    assert len(live.lines) == 3
    assert not set(live.lines.values()) & set(before.values())


async def test_error_1101_serves_nothing_until_new_data_arrives(wire):
    live = await session()
    c = contract(7580, "C")
    await live.source.spot(SPX, wait=0)
    live.source.watch([c])
    live.tick(10.0)

    live.ib.wrapper.error(-1, 1101, LOST_DATA, "")

    assert live.source.watch([c])[key(c)] is None
    assert await live.source.spot(SPX) is None
    live.tick(20.0)
    assert live.source.watch([c])[key(c)]["bid"] == 20.0
    assert (await live.source.spot(SPX))["price"] == 20.5


# -- tickers from cancelled lines ---------------------------------------------
async def test_control_plain_ib_keeps_the_ticker_after_cancel(wire):
    """The bug `MarketDataIB.cancelMktData` closes. A failure here means ib_async changed."""
    ib = IB()
    await read_only_connect(ib)
    option = Option("SPX", EXPIRY, 7580.0, "C", "SMART", conId=1)
    first = ib.reqMktData(option)

    ib.cancelMktData(option)

    assert ib.reqMktData(option) is first


async def test_cancel_forgets_the_ticker(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    option = Option("SPX", EXPIRY, 7580.0, "C", "SMART", conId=1)
    first = ib.reqMktData(option)

    assert ib.cancelMktData(option) is True

    assert ib.wrapper.tickers == {}
    assert ib.reqMktData(option) is not first


async def test_cancel_of_an_unknown_contract_reports_false(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    assert ib.cancelMktData(Option("SPX", EXPIRY, 7580.0, "C", "SMART", conId=1)) is False


async def test_second_snapshot_waits_for_its_own_quotes(wire):
    live = await session()

    async def snapshot_while_market_is(bid):
        task = asyncio.create_task(
            live.source.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=2.0))
        await eventually(lambda: len(live.lines) == 2)
        await asyncio.sleep(0)
        assert not task.done()
        live.tick(bid)
        return await bounded(task)

    assert (await snapshot_while_market_is(10.0))[(7580.0, "C")]["bid"] == 10.0
    assert (await snapshot_while_market_is(20.0))[(7580.0, "C")]["bid"] == 20.0


async def test_second_snapshot_with_no_new_quotes_returns_nothing(wire):
    clock = Clock()
    live = await session(clock)
    task = asyncio.create_task(live.source.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=2.0))
    await eventually(lambda: len(live.lines) == 2)
    live.tick(10.0)
    assert set(await bounded(task)) == {(7580.0, "C"), (7580.0, "P")}

    clock.step = 0.5
    assert await bounded(live.source.snapshot(SPX, EXPIRY, "SPXW", [7580.0], wait=2.0)) == {}


async def test_reopened_watch_shows_nothing_from_before(wire):
    clock = Clock()
    live = await session(clock)
    c = contract(7580, "C")
    live.source.watch([c])
    live.tick(10.0)
    clock.t = 60
    live.source.prune()

    assert live.source.watch([c])[key(c)] is None

    live.tick(20.0)
    assert live.source.watch([c])[key(c)]["bid"] == 20.0


async def test_reopened_spot_shows_nothing_from_before(wire):
    clock = Clock()
    live = await session(clock)
    await live.source.spot(SPX, wait=0)
    live.tick(10.0)
    clock.t = 60
    live.source.prune()

    assert await live.source.spot(SPX, wait=0) is None

    live.tick(20.0)
    assert (await live.source.spot(SPX))["price"] == 20.5


# -- the broker's reads ---------------------------------------------------------
REQ_EXECUTIONS, REQ_POSITIONS, CANCEL_POSITIONS = 7, 61, 64


async def test_fetch_executions_sends_one_executions_request(wire):
    ib = BrokerIB()
    await read_only_connect(ib)

    task = asyncio.create_task(ib.fetch_executions())
    await eventually(lambda: wire.calls == ["reqExecutions"])
    req_id = wire.sent[-1][2]
    ib.wrapper.execDetailsEnd(req_id)

    assert await bounded(task) == []
    assert [f[0] for f in wire.sent] == [REQ_EXECUTIONS]


async def test_fetch_positions_requests_then_cancels_the_subscription(wire):
    ib = BrokerIB()
    await read_only_connect(ib)

    task = asyncio.create_task(ib.fetch_positions())
    await eventually(lambda: wire.calls == ["reqPositions"])
    ib.wrapper.positionEnd()

    assert await bounded(task) == []
    assert [f[0] for f in wire.sent] == [REQ_POSITIONS, CANCEL_POSITIONS]


async def test_connecting_still_reads_no_executions_or_positions(wire):
    await read_only_connect(BrokerIB())

    assert wire.calls == []
    assert wire.sent == []


@pytest.mark.parametrize("name", ORDER_SENDS)
async def test_no_order_send_gets_out_after_a_broker_read(wire, name):
    ib = BrokerIB()
    await read_only_connect(ib)
    task = asyncio.create_task(ib.fetch_positions())
    await eventually(lambda: wire.calls == ["reqPositions"])
    ib.wrapper.positionEnd()
    await bounded(task)
    sent = list(wire.sent)
    arguments = len(inspect.signature(getattr(Client, name)).parameters) - 1

    with pytest.raises(BlockedRequest):
        getattr(ib.client, name)(*[0] * arguments)

    assert wire.sent == sent


# -- the cash summary: the one account read beyond executions and positions -----
async def test_account_summary_read_asks_for_four_tags_then_cancels(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    wire.sent.clear()

    task = asyncio.ensure_future(ib.fetch_account_summary())
    await asyncio.sleep(0)
    assert len(wire.sent) == 1
    fields = wire.sent[0]
    assert fields[0] == ACCOUNT_SUMMARY
    assert fields[3] == "All" and set(fields[4].split(",")) == SUMMARY_TAGS
    req_id = fields[2]
    ib.wrapper.accountSummary(req_id, "DU1", "TotalCashValue", "1000.5", "USD")
    ib.wrapper.accountSummary(req_id, "DU1", "NetLiquidation", "5000", "USD")
    ib.wrapper.accountSummaryEnd(req_id)

    values = await bounded(task)

    assert sorted((v.tag, v.value) for v in values) == [
        ("NetLiquidation", "5000"), ("TotalCashValue", "1000.5")]
    assert [f[0] for f in wire.sent] == [ACCOUNT_SUMMARY, CANCEL_ACCOUNT_SUMMARY]


async def test_account_summary_read_is_cancelled_when_tws_never_answers(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    wire.sent.clear()

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(ib.fetch_account_summary(), SHORT)

    # TWS must not keep streaming a summary nobody is waiting for.
    assert [f[0] for f in wire.sent] == [ACCOUNT_SUMMARY, CANCEL_ACCOUNT_SUMMARY]


async def test_account_summary_read_ignores_tags_it_did_not_ask_for(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    wire.sent.clear()

    task = asyncio.ensure_future(ib.fetch_account_summary())
    await asyncio.sleep(0)
    req_id = wire.sent[0][2]
    ib.wrapper.accountSummary(req_id, "DU1", "AccountType", "INDIVIDUAL", "")
    ib.wrapper.accountSummary(req_id, "DU1", "TotalCashValue", "10", "USD")
    ib.wrapper.accountSummaryEnd(req_id)

    assert [v.tag for v in await bounded(task)] == ["TotalCashValue"]


async def test_connecting_and_the_library_paths_still_never_request_the_summary(wire):
    ib = MarketDataIB()
    await read_only_connect(ib)
    assert ACCOUNT_SUMMARY not in [f[0] for f in wire.sent]
    # ib_async asks for the whole summary on its own (e.g. after error 1102): that stays empty.
    assert await bounded(ib.reqAccountSummaryAsync()) == []
    assert await bounded(ib.accountSummaryAsync()) == []
    assert ACCOUNT_SUMMARY not in [f[0] for f in wire.sent]


@pytest.mark.parametrize("name", ["reqAccountUpdates", "reqAccountUpdatesMulti", "reqPnL",
                                  "reqManagedAccts", "reqPositionsMulti", "placeOrder"])
async def test_opening_the_summary_does_not_open_other_account_requests(wire, name):
    ib = MarketDataIB()
    await read_only_connect(ib)
    arguments = len(inspect.signature(getattr(Client, name)).parameters) - 1
    wire.sent.clear()

    with pytest.raises(BlockedRequest):
        getattr(ib.client, name)(*[0] * arguments)

    assert wire.sent == []
