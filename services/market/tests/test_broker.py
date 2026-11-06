"""Executions and positions over the shared connection. No TWS: a fake IB hands back
real ib_async data classes, and commission reports are filled in the way the
library's wrapper does it (on its own Fill objects only)."""
import asyncio
from datetime import datetime, timezone

import pytest
from ib_async import (
    AccountValue, CommissionReport, Contract, Execution, Fill, Option, Position, Stock,
)

from broker import (
    BUSY, BUSY_CODE, CONNECTION_LOST, NOT_CONNECTED, NOT_CONNECTED_CODE, TIMEOUT_CODE, UNSET,
    Broker, account_rows, execution_row, ny_iso, position_row,
)
from errors import CodedError
from fake_ib import FakeIB
from ibkr import IbkrSource
from ibkr_support import Clock, bounded
from router import Router

NOW = datetime(2026, 11, 5, 15, 0, tzinfo=timezone.utc)  # 10:00 New York (EST)


def option(symbol="SPY", strike=540.0, right="P", expiry="20261218", multiplier="100"):
    return Option(symbol, expiry, strike, right, "SMART", multiplier, "USD", conId=4242)


def fill(exec_id="0001", side="BOT", shares=2, price=3.1, contract=None,
         when=datetime(2026, 7, 1, 14, 30, tzinfo=timezone.utc), commission=None):
    execution = Execution(execId=exec_id, time=when, acctNumber="DU123", side=side,
                          shares=shares, price=price, permId=77, orderId=5)
    # A repeat request's Fill carries an empty report until IBKR sends one.
    report = (CommissionReport(execId=exec_id, commission=commission)
              if commission is not None else CommissionReport())
    return Fill(contract or option(), execution, report, when)


class BrokerFakeIB(FakeIB):
    """FakeIB plus the broker reads. `wrapper_fills` stands in for ib.fills()."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.returned: list = []
        self.wrapper_fills: dict[str, Fill] = {}
        self.positions_list: list = []
        self.summary_list: list = []
        self.fetch_delay = 0.0
        self.fetch_error: Exception | None = None
        self.on_fetch = None

    async def _fetch(self, result):
        if self.fetch_error is not None:
            raise self.fetch_error
        if self.fetch_delay:
            await asyncio.sleep(self.fetch_delay)
        if self.on_fetch:
            self.on_fetch()
        return result

    async def fetch_executions(self):
        return await self._fetch(list(self.returned))

    async def fetch_positions(self):
        return await self._fetch(list(self.positions_list))

    async def fetch_account_summary(self):
        return await self._fetch(list(self.summary_list))

    def fills(self):
        return list(self.wrapper_fills.values())


def value(tag, amount, account="DU123", currency="USD"):
    return AccountValue(account, tag, str(amount), currency, "")


def report(exec_id, commission):
    return CommissionReport(execId=exec_id, commission=commission)


def broker_for(ib, **kwargs):
    src = IbkrSource(ib, clock=Clock(step=0.5))
    kwargs.setdefault("commission_wait", 0.05)
    kwargs.setdefault("commission_poll", 0.001)
    return Broker(src, now=lambda: NOW, **kwargs), src


def returned_and_wrapped(ib, *fills_, commissions):
    """The request returns fresh Fills with no commission; the wrapper's own copies
    carry whatever has been reported."""
    ib.returned = list(fills_)
    for f, c in zip(fills_, commissions):
        ib.wrapper_fills[f.execution.execId] = f._replace(
            commissionReport=report(f.execution.execId, c) if c is not None
            else CommissionReport())


# -- rows -----------------------------------------------------------------------
def test_bought_option_row():
    row = execution_row(fill(commission=1.3))
    assert row == {
        "exec_id": "0001", "order_id": 5, "perm_id": 77,
        "executed_at": "2026-07-01T10:30:00",  # EDT: UTC-4
        "symbol": "SPY", "sec_type": "OPT", "kind": "put", "strike": 540.0,
        "expiry": "2026-12-18", "multiplier": 100, "con_id": 4242,
        "qty": 2.0, "price": 3.1, "commission": 1.3, "commission_known": True,
        "account": "DU123",
    }


def test_sold_is_negative_and_winter_time_is_est():
    row = execution_row(fill(side="SLD", when=datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc)))
    assert row["qty"] == -2.0
    assert row["executed_at"] == "2026-01-05T09:30:00"


def test_dst_change_day_is_converted_correctly():
    # 2026-03-08 07:30 UTC is 03:30 EDT, just after clocks went forward at 02:00 EST.
    assert ny_iso(datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc)) == "2026-03-08T03:30:00"
    assert ny_iso(datetime(2026, 3, 8, 6, 30)) == "2026-03-08T01:30:00"  # naive = UTC


def test_stock_row():
    stock = Stock("AAPL", "SMART", "USD", conId=9)
    row = execution_row(fill(contract=stock, shares=100, price=230.5))
    assert (row["kind"], row["strike"], row["expiry"], row["multiplier"]) == ("stock", None, None, 1)
    assert row["qty"] == 100.0


@pytest.mark.parametrize("sec_type", ["BAG", "FUT", "CASH"])
def test_other_types_are_skipped(sec_type):
    assert execution_row(fill(contract=Contract(secType=sec_type, symbol="SPY"))) is None


@pytest.mark.parametrize("value", [UNSET * 2, float("nan"), None])
def test_unknown_commission(value):
    f = fill()
    f = f._replace(commissionReport=CommissionReport(execId="0001", commission=value))
    row = execution_row(f)
    assert row["commission"] == 0.0 and row["commission_known"] is False


def test_no_report_yet_is_unknown():
    row = execution_row(fill(commission=None))
    assert row["commission"] == 0.0 and row["commission_known"] is False


def test_a_reported_zero_commission_is_known():
    row = execution_row(fill(commission=0.0))
    assert row["commission"] == 0.0 and row["commission_known"] is True


def test_a_rebate_is_passed_on_unchanged():
    row = execution_row(fill(commission=-1.25))
    assert row["commission"] == -1.25 and row["commission_known"] is True


def test_option_position_cost_is_per_share():
    contract = option()
    contract.tradingClass = "SPYW"
    p = Position("DU123", contract, -2.0, 310.0)
    assert position_row(p) == {
        "account": "DU123", "symbol": "SPY", "sec_type": "OPT", "kind": "put",
        "strike": 540.0, "expiry": "2026-12-18", "multiplier": 100, "con_id": 4242,
        "trading_class": "SPYW", "qty": -2.0, "avg_cost": 3.1,
    }


def test_position_row_carries_the_trading_class_for_options_only():
    c = option()
    c.tradingClass = "SPYW"
    assert position_row(Position("DU1", c, 1.0, 1.0))["trading_class"] == "SPYW"
    c.tradingClass = ""
    assert position_row(Position("DU1", c, 1.0, 1.0))["trading_class"] == "SPY"   # falls back to the symbol
    stock = position_row(Position("DU1", Stock("AAPL", "SMART", "USD", conId=9), 1.0, 1.0))
    assert stock["trading_class"] is None


def test_stock_position_cost_is_unchanged():
    p = Position("DU123", Stock("AAPL", "SMART", "USD", conId=9), 100.0, 230.5)
    row = position_row(p)
    assert row["avg_cost"] == 230.5 and row["kind"] == "stock"


def test_bag_position_is_skipped():
    assert position_row(Position("DU1", Contract(secType="BAG"), 1.0, 1.0)) is None


# -- broker ---------------------------------------------------------------------
async def test_executions_read_commissions_from_the_wrapper():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib)
    returned_and_wrapped(ib, fill("a"), fill("b", side="SLD"), commissions=[1.1, 0.65])

    out = await bounded(b.executions())

    assert out["as_of"] == "2026-11-05T10:00:00"
    assert [(r["exec_id"], r["qty"], r["commission"], r["commission_known"])
            for r in out["executions"]] == [("a", 2.0, 1.1, True), ("b", -2.0, 0.65, True)]


async def test_executions_wait_for_late_commission_reports():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib, commission_wait=1.0)
    returned_and_wrapped(ib, fill("a"), commissions=[None])

    async def report_later():
        await asyncio.sleep(0.02)
        ib.wrapper_fills["a"] = ib.wrapper_fills["a"]._replace(commissionReport=report("a", 1.3))

    task = asyncio.create_task(report_later())
    out = await bounded(b.executions())
    await task

    assert out["executions"][0]["commission"] == 1.3


async def test_executions_give_up_waiting_and_mark_unknown():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib, commission_wait=0.02)
    returned_and_wrapped(ib, fill("a"), commissions=[UNSET * 2])

    row = (await bounded(b.executions()))["executions"][0]

    assert row["commission"] == 0.0 and row["commission_known"] is False


async def test_bag_executions_are_left_out():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib)
    bag = fill("bag", contract=Contract(secType="BAG", symbol="SPY"))
    returned_and_wrapped(ib, bag, fill("leg"), commissions=[0.0, 1.0])

    out = await bounded(b.executions())

    assert [r["exec_id"] for r in out["executions"]] == ["leg"]


async def test_positions():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib)
    ib.positions_list = [Position("DU1", option(), 1.0, 250.0)]

    out = await bounded(b.positions())

    assert out == {"positions": [position_row(ib.positions_list[0])],
                   "as_of": "2026-11-05T10:00:00"}
    assert out["positions"][0]["avg_cost"] == 2.5


def test_account_row_names_the_four_values_and_parses_the_numbers():
    rows = account_rows([
        value("TotalCashValue", "12345.67"), value("NetLiquidation", "50000.5"),
        value("AvailableFunds", "9000"), value("BuyingPower", "18000"),
    ])
    assert rows == [{"account": "DU123", "currency": "USD", "cash": 12345.67,
                     "net_liquidation": 50000.5, "available_funds": 9000.0,
                     "buying_power": 18000.0}]


def test_account_rows_are_one_per_account_and_currency_sorted_by_account():
    rows = account_rows([
        value("TotalCashValue", 5, account="DU2"), value("TotalCashValue", 7, account="DU1"),
        value("TotalCashValue", 9, account="DU1", currency="EUR"),
    ])
    assert [(r["account"], r["currency"], r["cash"]) for r in rows] == [
        ("DU1", "EUR", 9.0), ("DU1", "USD", 7.0), ("DU2", "USD", 5.0)]


@pytest.mark.parametrize("bad", ["", "n/a", "nan", "inf", str(UNSET), "-1e300"])
def test_account_values_that_are_not_real_numbers_are_none_not_zero(bad):
    # A missing figure must never read as "$0 in cash".
    row = account_rows([value("TotalCashValue", bad), value("NetLiquidation", 100)])[0]
    assert row["cash"] is None
    assert row["net_liquidation"] == 100.0


def test_account_rows_ignore_other_tags_and_an_empty_answer():
    assert account_rows([]) == []
    assert account_rows([value("AccountType", "INDIVIDUAL"), value("Leverage", "0.2")]) == []


def test_a_negative_cash_balance_is_kept_as_is():
    # Margin accounts can sit at negative cash; it is a real figure, not an error.
    assert account_rows([value("TotalCashValue", "-250.4")])[0]["cash"] == -250.4


async def test_account():
    ib = BrokerFakeIB()
    ib.summary_list = [value("TotalCashValue", 1000), value("NetLiquidation", 2500)]
    b, _ = broker_for(ib)

    out = await bounded(b.account())

    assert out == {"accounts": account_rows(ib.summary_list), "as_of": ny_iso(NOW)}
    assert out["accounts"][0]["cash"] == 1000.0


@pytest.mark.parametrize("op", ["executions", "positions", "account"])
async def test_not_connected_is_a_clear_error_and_does_not_connect(op):
    ib = BrokerFakeIB(connected=False)
    b, _ = broker_for(ib)

    with pytest.raises(ValueError, match=NOT_CONNECTED):
        await bounded(getattr(b, op)())

    assert ib.client_ids_tried == []


@pytest.mark.parametrize("op", ["executions", "positions", "account"])
async def test_a_stalled_tws_times_out(op):
    ib = BrokerFakeIB()
    b, _ = broker_for(ib, fetch_timeout=0.01)
    ib.fetch_delay = 1.0

    with pytest.raises(ValueError, match=f"did not answer the {op} request"):
        await bounded(getattr(b, op)())


async def test_a_dropped_socket_mid_request_is_a_clear_error():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib)
    ib.fetch_error = ConnectionError("Socket disconnect")

    with pytest.raises(ValueError, match=CONNECTION_LOST):
        await bounded(b.executions())


async def test_a_second_read_while_one_runs_is_refused_as_busy():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib)
    ib.fetch_delay = 0.05

    first = asyncio.create_task(b.executions())
    await asyncio.sleep(0)
    with pytest.raises(CodedError, match=BUSY) as err:
        await bounded(b.positions())
    assert err.value.code == BUSY_CODE
    await bounded(first)
    assert (await bounded(b.positions()))["positions"] == []  # free again afterwards


# -- disconnect and the router ops ---------------------------------------------
async def test_disconnect_closes_the_socket_and_forgets_streams():
    ib = BrokerFakeIB()
    _, src = broker_for(ib)
    from ibkr_support import contract
    src.watch([contract(7580, "C")])

    await src.disconnect()

    assert ib.isConnected() is False
    assert src.offline_reason == "disconnected; press Connect IBKR"
    assert src._streams == {}


async def test_disconnect_when_already_disconnected_sends_nothing():
    ib = BrokerFakeIB(connected=False)
    _, src = broker_for(ib)

    await src.disconnect()

    assert getattr(ib, "disconnect_calls", 0) == 0


async def test_router_disconnect_op_returns_status():
    ib = BrokerFakeIB()
    b, src = broker_for(ib)
    router = Router(src, None, now=lambda: NOW, broker=b)

    assert await router.handle("disconnect", {}) == {
        "ibkr": "disconnected", "reason": "disconnected; press Connect IBKR"}


async def test_router_executions_and_positions_ops():
    ib = BrokerFakeIB()
    b, src = broker_for(ib)
    returned_and_wrapped(ib, fill("a"), commissions=[1.0])
    ib.positions_list = [Position("DU1", option(), 1.0, 250.0)]
    ib.summary_list = [value("TotalCashValue", 4200)]
    router = Router(src, None, now=lambda: NOW, broker=b)

    executions = await router.handle("executions", {})
    positions = await router.handle("positions", {})
    account = await router.handle("account", {})

    assert executions["executions"][0]["exec_id"] == "a"
    assert positions["positions"][0]["avg_cost"] == 2.5
    assert account["accounts"][0]["cash"] == 4200.0


async def test_router_builds_its_own_broker_on_the_shared_source():
    ib = BrokerFakeIB(connected=False)
    src = IbkrSource(ib, clock=Clock(step=0.5))
    router = Router(src, None, now=lambda: NOW)

    with pytest.raises(ValueError, match=NOT_CONNECTED):
        await router.handle("executions", {})
    assert ib.client_ids_tried == []
