import asyncio
import inspect
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def pytest_pyfunc_call(pyfuncitem):
    """Run coroutine tests with asyncio.run (no pytest-asyncio)."""
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        args = {n: pyfuncitem.funcargs[n] for n in pyfuncitem._fixtureinfo.argnames}
        asyncio.run(pyfuncitem.obj(**args))
        return True
    return None


@pytest.fixture(autouse=True)
def fast_polling(monkeypatch):
    """IbkrSource wait loops spin without real sleeps. Looked up, not imported, so
    tests that never touch ibkr do not load ib_async."""
    if "ibkr" in sys.modules:
        monkeypatch.setattr(sys.modules["ibkr"], "POLL_SECONDS", 0)


ACCOUNT_REQUESTS = (
    "reqPositions", "reqPositionsMulti", "reqAccountUpdates", "reqAccountUpdatesMulti",
    "reqAccountSummary", "reqOpenOrders", "reqAllOpenOrders", "reqAutoOpenOrders",
    "reqCompletedOrders", "reqExecutions",
)


class Wire:
    def __init__(self):
        self.sent: list[tuple] = []     # every message handed to the socket layer
        self.calls: list[str] = []      # every account or order request made


@pytest.fixture
def wire(monkeypatch):
    """Imported here, so tests that never touch ibkr do not load ib_async."""
    from ib_async.client import Client
    from ib_async.connection import Connection

    recorded = Wire()

    async def connect(client, host, port, clientId, timeout=2.0):
        client.clientId = clientId
        client.connState = Client.CONNECTED
        client._apiReady = True
        client._accounts = ["DU0000000"]
        client._serverVersion = Client.MaxClientVersion
        client._hasReqId = True
        client._reqIdSeq = 1

    def spy_on(name):
        original = getattr(Client, name)

        def spy(client, *args, **kwargs):
            recorded.calls.append(name)
            return original(client, *args, **kwargs)

        return spy

    def no_socket(*args, **kwargs):
        raise AssertionError("a test tried to open a socket")

    monkeypatch.setattr(Client, "connectAsync", connect)
    monkeypatch.setattr(
        Client, "send", lambda client, *fields, makeEmpty=True: recorded.sent.append(fields))
    monkeypatch.setattr(Connection, "connectAsync", no_socket)
    for name in ACCOUNT_REQUESTS:
        monkeypatch.setattr(Client, name, spy_on(name))
    return recorded
