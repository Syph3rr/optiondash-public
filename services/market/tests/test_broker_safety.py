"""Broker failure codes, Disconnect during a read, and the wire-level order guard.
No TWS: FakeIB for the broker flow, and the real ib_async client with only its socket
send stubbed (`wire`) for what would leave the process."""
import asyncio

import pytest
from ib_async import Position
from ib_async.ib import StartupFetchNONE

from broker import (
    CONNECTION_LOST, NOT_CONNECTED, NOT_CONNECTED_CODE, TIMEOUT_CODE, position_row,
)
from errors import CodedError
from ibkr import BLOCKED_MESSAGE_IDS, LINK_DOWN_REASON, BlockedRequest, BrokerIB, IbkrSource
from ibkr_support import Clock, bounded
from main import _error
from test_broker import BrokerFakeIB, broker_for, option

FAST = 0.5  # a read the user abandons must fail well inside this


# -- codes the gateway maps ------------------------------------------------------
async def test_not_connected_carries_its_code():
    b, _ = broker_for(BrokerFakeIB(connected=False))
    with pytest.raises(CodedError, match=NOT_CONNECTED) as err:
        await bounded(b.executions())
    assert err.value.code == NOT_CONNECTED_CODE


async def test_timeout_carries_its_code_and_message():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib, fetch_timeout=0.01)
    ib.fetch_delay = 1.0
    with pytest.raises(CodedError, match="did not answer the executions request") as err:
        await bounded(b.executions())
    assert err.value.code == TIMEOUT_CODE


async def test_lost_socket_is_not_connected():
    ib = BrokerFakeIB()
    b, _ = broker_for(ib)
    ib.fetch_error = ConnectionError("Socket disconnect")
    with pytest.raises(CodedError, match=CONNECTION_LOST) as err:
        await bounded(b.executions())
    assert err.value.code == NOT_CONNECTED_CODE


async def test_tws_cut_off_from_ibkr_says_so_instead_of_press_connect():
    ib = BrokerFakeIB()
    b, src = broker_for(ib)
    ib.errorEvent.emit(-1, 1100, "Connectivity between IB and TWS has been lost.", None)

    with pytest.raises(CodedError, match=LINK_DOWN_REASON) as err:
        await bounded(b.positions())

    assert err.value.code == NOT_CONNECTED_CODE
    assert "press Connect" not in str(err.value)
    assert ib.client_ids_tried == []


def test_stdio_error_reply_includes_the_code():
    reply = _error(7, CodedError("busy now", "busy"))
    assert reply == {"id": 7, "ok": False, "error": "busy now", "code": "busy"}


def test_plain_value_errors_have_no_code():
    assert "code" not in _error(1, ValueError("bad symbol"))


# -- Disconnect while a read is in flight ----------------------------------------
async def test_disconnect_fails_a_read_in_flight_at_once_and_frees_the_lock():
    ib = BrokerFakeIB()
    b, src = broker_for(ib, fetch_timeout=10.0)
    ib.fetch_delay = 10.0

    read = asyncio.create_task(b.executions())
    await asyncio.sleep(0.01)
    await src.disconnect()

    with pytest.raises(CodedError, match=CONNECTION_LOST) as err:
        await asyncio.wait_for(read, FAST)
    assert err.value.code == NOT_CONNECTED_CODE
    assert not b._lock.locked()


async def test_after_reconnect_reads_work_again():
    ib = BrokerFakeIB()
    b, src = broker_for(ib)
    await src.disconnect()
    assert await src.connect() is True

    assert (await bounded(b.executions()))["executions"] == []


async def test_disconnect_fails_the_librarys_pending_futures(wire):
    ib = BrokerIB()
    await bounded(ib.connectAsync("127.0.0.1", 7496, clientId=17, timeout=0.01,
                                  readonly=True, fetchFields=StartupFetchNONE))
    src = IbkrSource(ib, clock=Clock(step=0.5))

    read = asyncio.ensure_future(ib.fetch_executions())
    await asyncio.sleep(0)
    await src.disconnect()

    with pytest.raises(ConnectionError):
        await asyncio.wait_for(read, FAST)


# -- positions -------------------------------------------------------------------
def test_closed_positions_are_skipped():
    assert position_row(Position("DU1", option(), 0.0, 0.0)) is None


async def test_positions_subscription_is_cancelled_even_on_timeout(wire):
    ib = BrokerIB()
    await bounded(ib.connectAsync("127.0.0.1", 7496, clientId=17, timeout=0.01,
                                  readonly=True, fetchFields=StartupFetchNONE))

    with pytest.raises(TimeoutError):
        await asyncio.wait_for(ib.fetch_positions(), 0.01)

    assert "reqPositions" in wire.calls
    assert (64, 1) in wire.sent  # CANCEL_POSITIONS


# -- wire-level order guard -----------------------------------------------------
@pytest.mark.parametrize("msg_id", sorted(BLOCKED_MESSAGE_IDS))
async def test_a_raw_order_send_is_refused_before_the_wire(wire, msg_id):
    ib = BrokerIB()
    with pytest.raises(BlockedRequest):
        ib.client.send(msg_id, 1, 0)
    with pytest.raises(BlockedRequest):
        ib.client.sendMsg(f"{msg_id}\0" + "1\0")
    assert wire.sent == []


def test_order_message_ids_cover_every_order_operation():
    # PLACE_ORDER, CANCEL_ORDER, REQ_OPEN_ORDERS, REQ_IDS, REQ_AUTO_OPEN_ORDERS,
    # REQ_ALL_OPEN_ORDERS, EXERCISE_OPTIONS, REQ_GLOBAL_CANCEL, REQ_COMPLETED_ORDERS
    assert BLOCKED_MESSAGE_IDS == {3, 4, 5, 8, 15, 16, 21, 58, 99}


async def test_market_data_sends_still_pass_the_guard(wire):
    ib = BrokerIB()
    ib.client.send(59, 1, 4)  # REQ_MARKET_DATA_TYPE
    assert wire.sent == [(59, 1, 4)]
