import asyncio
import inspect

import pytest
from ib_async import IB, OptionChain
from ib_async.ib import StartupFetchNONE

import ibkr
from contracts import resolve
from fake_ib import FakeIB, ticker
from ibkr import IbkrSource, contract_key as key
from ibkr_support import (
    EXPIRY, NAN, SPX, SPY, Clock, bounded, contract, contracts, eventually, option_details,
    source,
)


@pytest.mark.parametrize("name", [
    "isConnected", "connectAsync", "reqMarketDataType", "reqMktData", "cancelMktData",
    "qualifyContractsAsync", "reqContractDetailsAsync", "reqSecDefOptParamsAsync",
])
def test_fake_keeps_the_ib_async_signature(name):
    real = inspect.signature(getattr(IB, name)).parameters
    fake = inspect.signature(getattr(FakeIB, name)).parameters
    assert list(fake) == list(real)


def test_default_ib_starts_disconnected_without_a_socket():
    s = IbkrSource()
    assert s.connected is False


async def test_reads_on_the_unconnected_default_ib_touch_no_socket():
    s = IbkrSource()
    c = contract(7580, "C")
    assert await s.spot(SPX) is None
    assert s.watch([c]) == {key(c): None}
    assert await s.expiries(SPX) == []
    assert await s.strikes(SPX, EXPIRY, "SPXW") == []
    assert await s.snapshot(SPX, EXPIRY, "SPXW", [7580.0]) == {}


# -- connection ---------------------------------------------------------------
async def test_connects_read_only_without_account_data():
    fake = FakeIB(); await source(fake).connect_once()
    assert fake.connect_kwargs["readonly"] is True
    assert fake.connect_kwargs["fetchFields"] == StartupFetchNONE


async def test_requests_delayed_frozen_type_after_connect():
    fake = FakeIB(); await source(fake).connect_once()
    assert fake.market_data_type == 4


async def test_each_connect_requests_the_data_type_once():
    fake = FakeIB(connected=False)
    s = source(fake)
    await s.connect_once()
    fake.drop()
    await s.connect_once()
    assert fake.market_data_type_calls == 2


async def test_client_id_in_use_tries_next_four():
    fake = FakeIB(connected=False)
    fake.busy_client_ids = {17, 18, 19, 20, 21, 22}
    s = source(fake)

    assert await s.connect_once() is False
    assert fake.client_ids_tried == [17, 18, 19, 20, 21]
    assert s.connected is False
    assert fake.market_data_type is None

    fake.client_ids_tried.clear()
    fake.busy_client_ids = {17, 18}
    assert await s.connect_once() is True
    assert fake.client_ids_tried == [17, 18, 19]
    assert s.connected is True


async def test_other_connect_failures_do_not_try_more_ids():
    fake = FakeIB(connected=False)
    fake.refuse_connections = True
    assert await source(fake).connect_once() is False
    assert fake.client_ids_tried == [17]


async def test_settings_default_from_the_environment(monkeypatch):
    monkeypatch.setenv("IBKR_HOST", "10.0.0.5")
    monkeypatch.setenv("IBKR_PORT", "4001")
    monkeypatch.setenv("IBKR_CLIENT_ID", "30")
    fake = FakeIB(connected=False)
    await IbkrSource(fake).connect_once()
    kw = fake.connect_kwargs
    assert (kw["host"], kw["port"], kw["clientId"]) == ("10.0.0.5", 4001, 30)


async def test_settings_fall_back_to_the_documented_defaults(monkeypatch):
    for name in ("IBKR_HOST", "IBKR_PORT", "IBKR_CLIENT_ID"):
        monkeypatch.delenv(name, raising=False)
    fake = FakeIB(connected=False)
    await IbkrSource(fake).connect_once()
    kw = fake.connect_kwargs
    assert (kw["host"], kw["port"], kw["clientId"]) == ("127.0.0.1", 7496, 17)


async def test_explicit_settings_beat_the_environment(monkeypatch):
    monkeypatch.setenv("IBKR_PORT", "4001")
    fake = FakeIB(connected=False)
    await IbkrSource(fake, host="h", port=7497, client_id=40).connect_once()
    kw = fake.connect_kwargs
    assert (kw["host"], kw["port"], kw["clientId"]) == ("h", 7497, 40)


@pytest.mark.parametrize("client_id", [0, -1, -3, -4, -100])
def test_client_id_below_one_is_rejected(client_id):
    with pytest.raises(ValueError, match="client id"):
        IbkrSource(FakeIB(), client_id=client_id)


@pytest.mark.parametrize("client_id", ["0", "-2"])
def test_client_id_below_one_from_the_environment_is_rejected(monkeypatch, client_id):
    monkeypatch.setenv("IBKR_CLIENT_ID", client_id)
    with pytest.raises(ValueError, match="client id"):
        IbkrSource(FakeIB())


def test_client_id_one_is_the_lowest_allowed():
    assert IbkrSource(FakeIB(), client_id=1).connected is True


async def test_run_forever_never_connects_on_its_own(monkeypatch):
    monkeypatch.setattr(ibkr, "PRUNE_SECONDS", 0)
    fake = FakeIB(connected=False)
    s = source(fake)
    task = asyncio.create_task(s.run_forever())
    for _ in range(50):
        await asyncio.sleep(0)
    task.cancel()
    assert fake.client_ids_tried == []
    assert s.connected is False


async def test_run_forever_keeps_going_after_an_unexpected_error(monkeypatch):
    monkeypatch.setattr(ibkr, "PRUNE_SECONDS", 0)
    s = source(FakeIB(connected=False))
    calls = []

    def explode():
        calls.append(1)
        raise RuntimeError("boom")

    monkeypatch.setattr(s, "prune", explode)
    task = asyncio.create_task(s.run_forever())
    await eventually(lambda: len(calls) >= 2)
    assert task.done() is False
    task.cancel()


async def test_a_dropped_connection_is_not_retried_on_its_own(monkeypatch):
    monkeypatch.setattr(ibkr, "PRUNE_SECONDS", 0)
    fake = FakeIB(connected=False)
    s = source(fake)
    assert await s.connect() is True
    task = asyncio.create_task(s.run_forever())
    fake.drop()
    for _ in range(20):
        await asyncio.sleep(0)
    task.cancel()
    assert fake.client_ids_tried == [17]
    assert s.offline_reason == "connection to TWS lost"


async def test_connect_makes_one_attempt_each_time_it_is_asked():
    fake = FakeIB(connected=False)
    fake.refuse_connections = True
    s = source(fake)
    assert await s.connect() is False
    fake.refuse_connections = False
    assert await s.connect() is True
    assert fake.client_ids_tried == [17, 17]
    assert s.connected is True


async def test_connect_leaves_an_open_socket_alone():
    fake = FakeIB()
    assert await source(fake).connect() is True
    assert fake.client_ids_tried == []


async def test_two_connects_at_once_open_one_session():
    fake = FakeIB(connected=False)
    s = source(fake)
    assert await asyncio.gather(s.connect(), s.connect()) == [True, True]
    assert fake.client_ids_tried == [17]


async def test_connect_stays_read_only():
    fake = FakeIB(connected=False)
    await source(fake).connect()
    assert fake.connect_kwargs["readonly"] is True
    assert fake.connect_kwargs["fetchFields"] == StartupFetchNONE


async def test_run_forever_prunes_idle_streams_with_no_poll_running(monkeypatch):
    monkeypatch.setattr(ibkr, "PRUNE_SECONDS", 0)
    fake = FakeIB()
    clock = Clock()
    s = source(fake, clock)
    s.watch([contract(7580, "C")])
    assert fake.open_lines == 1
    clock.t = 60
    task = asyncio.create_task(s.run_forever())
    await eventually(lambda: fake.open_lines == 0)
    task.cancel()


# -- offline reason -----------------------------------------------------------
async def test_offline_reason_is_none_while_connected():
    s = source(fake := FakeIB(connected=False))
    await s.connect_once()
    assert fake.isConnected() is True
    assert s.offline_reason is None


async def test_offline_reason_before_any_attempt():
    assert source(FakeIB(connected=False)).offline_reason == "not connected to TWS; press Connect IBKR"


async def test_offline_reason_when_tws_refuses_the_connection():
    fake = FakeIB(connected=False)
    fake.refuse_connections = True
    s = source(fake)
    await s.connect_once()
    assert s.offline_reason == "TWS not reachable on 127.0.0.1:7496"


async def test_offline_reason_names_the_configured_address():
    fake = FakeIB(connected=False)
    fake.refuse_connections = True
    s = IbkrSource(fake, host="10.0.0.5", port=4001, client_id=17)
    await s.connect_once()
    assert s.offline_reason == "TWS not reachable on 10.0.0.5:4001"


async def test_offline_reason_when_tws_does_not_answer():
    fake = FakeIB(connected=False)
    fake.connect_error = TimeoutError()
    s = source(fake)
    await s.connect_once()
    assert s.offline_reason == "TWS did not respond on 127.0.0.1:7496"


async def test_offline_reason_when_every_client_id_is_in_use():
    fake = FakeIB(connected=False)
    fake.busy_client_ids = {17, 18, 19, 20, 21}
    s = source(fake)
    await s.connect_once()
    assert s.offline_reason.startswith("client ids 17-21 are in use")


async def test_offline_reason_follows_the_configured_client_id():
    fake = FakeIB(connected=False)
    fake.busy_client_ids = {30, 31, 32, 33, 34}
    s = IbkrSource(fake, client_id=30)
    await s.connect_once()
    assert s.offline_reason.startswith("client ids 30-34 are in use")


async def test_offline_reason_for_an_unexpected_connect_failure():
    fake = FakeIB(connected=False)
    fake.connect_error = RuntimeError("boom")
    s = source(fake)
    await s.connect_once()
    assert s.offline_reason == "could not connect to TWS on 127.0.0.1:7496"


async def test_offline_reason_after_the_connection_drops():
    s = source(fake := FakeIB(connected=False))
    await s.connect_once()
    fake.drop()
    assert s.offline_reason == "connection to TWS lost"


async def test_offline_reason_tracks_the_latest_attempt():
    s = source(fake := FakeIB(connected=False))
    await s.connect_once()
    fake.drop()

    fake.refuse_connections = True
    await s.connect_once()
    assert s.offline_reason == "TWS not reachable on 127.0.0.1:7496"

    fake.refuse_connections = False
    await s.connect_once()
    assert s.offline_reason is None


# -- spot ---------------------------------------------------------------------
async def test_spot_ignores_close():
    fake = FakeIB(ticker(last=float("nan"), close=7720.39, bid=-1, ask=-1))
    assert await source(fake).spot(SPX) is None


async def test_spot_reports_actual_data_type():
    q = await source(FakeIB(ticker(last=7580.95, md_type=1))).spot(SPX)
    assert (q["price"], q["data_type"]) == (7580.95, "live")


async def test_spot_row_matches_the_yahoo_shape():
    q = await source(FakeIB(ticker(last=7580.95, bid=-1, ask=-1, md_type=4))).spot(SPX)
    assert q == {"price": 7580.95, "source": "ibkr", "data_type": "delayed_frozen",
                 "as_of": "2026-11-01T11:00:00Z"}


async def test_spot_uses_last_when_bid_and_ask_are_nan():
    q = await source(FakeIB(ticker(bid=NAN, ask=NAN, last=590.5, md_type=3))).spot(SPY)
    assert (q["price"], q["data_type"]) == (590.5, "delayed")


async def test_spot_prefers_mid_when_both_sides_quote():
    q = await source(FakeIB(ticker(bid=100.0, ask=101.0, last=99.0))).spot(SPY)
    assert q["price"] == 100.5


async def test_spot_waits_for_a_first_tick_and_keeps_the_stream():
    fake = FakeIB()
    s = source(fake, Clock())
    task = asyncio.create_task(s.spot(SPX))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert not task.done()
    fake.tick_underlying("SPX", last=7580.95)
    q = await bounded(task)
    assert q["price"] == 7580.95
    assert fake.open_lines == 1


async def test_spot_gives_up_after_its_wait():
    clock = Clock(step=0.5)
    await source(FakeIB(), clock).spot(SPX, wait=2.0)
    assert 2.0 <= clock.t <= 3.5


async def test_later_spot_reads_the_cache_without_blocking():
    fake = FakeIB()
    s = source(fake, Clock())
    assert await s.spot(SPX, wait=0) is None
    assert await bounded(s.spot(SPX)) is None  # the Clock never moves: a wait would hang
    fake.tick_underlying("SPX", last=7581.0)
    q = await bounded(s.spot(SPX))
    assert q["price"] == 7581.0
    assert len(fake.mkt_data_requests) == 1


async def test_spot_streams_requests_no_generic_ticks():
    fake = FakeIB(ticker(last=7580.95))
    await source(fake).spot(SPX)
    assert fake.mkt_data_requests[0][1] == ""


async def test_spot_builds_an_index_contract():
    fake = FakeIB(ticker(last=7580.95))
    await source(fake).spot(SPX)
    c = fake.mkt_data_requests[0][0]
    assert (c.secType, c.symbol, c.exchange, c.currency) == ("IND", "SPX", "CBOE", "USD")


async def test_spot_builds_a_stock_contract():
    fake = FakeIB(ticker(last=590.5))
    await source(fake).spot(SPY)
    c = fake.mkt_data_requests[0][0]
    assert (c.secType, c.symbol, c.exchange, c.currency) == ("STK", "SPY", "SMART", "USD")


async def test_spot_is_none_while_disconnected():
    fake = FakeIB(ticker(last=7580.95), connected=False)
    assert await bounded(source(fake, Clock()).spot(SPX)) is None
    assert fake.mkt_data_requests == []


async def test_spot_of_an_unknown_symbol_is_none():
    fake = FakeIB(ticker(last=1.0))
    fake.unknown.add(("ZZZZ",))
    assert await bounded(source(fake, Clock()).spot(resolve("ZZZZ"))) is None
    assert fake.mkt_data_requests == []
    assert fake.open_lines == 0


async def test_spot_has_no_line_once_the_budget_is_spent():
    fake = FakeIB(ticker(last=7580.95))
    s = source(fake)
    s.watch(contracts(60))
    assert await bounded(s.spot(SPX)) is None
    assert fake.open_lines == 60


# -- expiries and strikes -----------------------------------------------------
async def test_expiries_merge_smart_chains_by_class_priority():
    fake = FakeIB()
    con_id = fake.con_id(ibkr.underlying_contract(SPX))
    fake.chains = [
        OptionChain("SMART", con_id, "SPX", "100", ["20261120", "20261218"], [7500.0]),
        OptionChain("SMART", con_id, "SPXW", "100", ["20261112", "20261120"], [7500.0]),
        OptionChain("CBOE", con_id, "SPXW", "100", ["20261113"], [7500.0]),
    ]
    assert await source(fake).expiries(SPX) == [
        {"expiry": "20261112", "trading_class": "SPXW"},
        {"expiry": "20261120", "trading_class": "SPXW"},
        {"expiry": "20261218", "trading_class": "SPX"},
    ]


async def test_expiries_of_an_unknown_symbol_are_empty():
    fake = FakeIB()
    fake.unknown.add(("ZZZZ",))
    assert await source(fake).expiries(resolve("ZZZZ")) == []


async def test_expiries_are_empty_while_disconnected():
    assert await source(FakeIB(connected=False)).expiries(SPX) == []


async def test_strikes_come_from_contract_details_for_that_expiry():
    fake = FakeIB()
    for strike in (7600.0, 7550.0, 7575.0):
        fake.add_details(option_details(strike))
    fake.add_details(option_details(7575.0))             # the put of a strike
    fake.add_details(option_details(756.0, expiry="20261120"))  # union-only strike
    fake.add_details(option_details(7000.0, trading_class="SPX"))
    fake.add_details(option_details(7001.0, multiplier="10"))
    assert await source(fake).strikes(SPX, EXPIRY, "SPXW") == [7550.0, 7575.0, 7600.0]


async def test_strikes_are_empty_while_disconnected():
    assert await source(FakeIB(connected=False)).strikes(SPX, EXPIRY, "SPXW") == []
