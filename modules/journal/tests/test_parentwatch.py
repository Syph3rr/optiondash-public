import os
import threading

import pytest

from app import parentwatch

WAIT_S = 5


def pipe():
    r, w = os.pipe()
    return os.fdopen(r, "rb", buffering=0), os.fdopen(w, "wb", buffering=0)


@pytest.mark.parametrize("env,expected", [
    ({"JOURNAL_PARENT_WATCH": "1"}, True),
    ({"JOURNAL_PARENT_WATCH": " 1 "}, True),
    ({"JOURNAL_PARENT_WATCH": "0"}, False),
    ({"JOURNAL_PARENT_WATCH": "yes"}, False),
    ({}, False),
])
def test_only_enabled_by_the_gateway_flag(env, expected):
    assert parentwatch.enabled(env) is expected


def test_fires_once_when_the_parent_closes_the_pipe():
    reader, writer = pipe()
    fired = threading.Event()
    calls = []
    thread = parentwatch.watch(reader, lambda: (calls.append(1), fired.set()))
    assert thread.daemon
    writer.write(b"keepalive\n")          # data before EOF does not stop the service
    assert not fired.wait(0.2)
    writer.close()
    assert fired.wait(WAIT_S)
    thread.join(WAIT_S)
    assert calls == [1]
    reader.close()


def test_a_failing_stream_also_counts_as_the_parent_gone():
    class Broken:
        def read(self, _n):
            raise OSError("broken pipe")

    fired = threading.Event()
    parentwatch.watch(Broken(), fired.set)
    assert fired.wait(WAIT_S)


def test_run_wires_the_watcher_to_uvicorn_shutdown(monkeypatch):
    import run

    servers, watched = [], []

    class FakeServer:
        def __init__(self, config):
            self.config, self.should_exit = config, False
            servers.append(self)

        def run(self):
            pass

    monkeypatch.setattr(run.uvicorn, "Server", FakeServer)
    monkeypatch.setattr(run, "create_app", lambda: object())
    monkeypatch.setattr(run.parentwatch, "watch", lambda stream, on_eof: watched.append(on_eof))
    monkeypatch.setenv("TRADELOG_PORT", "8123")

    monkeypatch.delenv("JOURNAL_PARENT_WATCH", raising=False)
    run.main()
    assert watched == [] and servers[-1].config.port == 8123 and servers[-1].config.host == "127.0.0.1"

    monkeypatch.setenv("JOURNAL_PARENT_WATCH", "1")
    run.main()
    assert len(watched) == 1
    watched[0]()
    assert servers[-1].should_exit is True
