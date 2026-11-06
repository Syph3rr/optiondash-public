import asyncio
import json
import logging
import os
import subprocess
import threading
import sys
from pathlib import Path

import main as main_module
from main import _main, serve
from router import NotFound

HERE = Path(__file__).resolve().parent


async def lines(*items):
    for item in items:
        yield item


def req(id_, op, args=None):
    return json.dumps({"id": id_, "op": op, "args": args or {}})


class StubRouter:
    def __init__(self, handler):
        self.handler = handler

    async def handle(self, op, args):
        return await self.handler(op, args)


async def run(router, *items):
    out = []
    await serve(lines(*items), out.append, router)
    return [json.loads(o) for o in out]


async def test_success_response():
    async def handler(op, args):
        return {"echo": op, "n": args["n"]}

    [r] = await run(StubRouter(handler), req(7, "status", {"n": 3}))
    assert r == {"id": 7, "ok": True, "data": {"echo": "status", "n": 3}}


async def test_bad_json_line_answers_with_error_and_keeps_serving():
    async def handler(op, args):
        return {}

    out = await run(StubRouter(handler), "{not json", "[1]", '{"id": 4}', req(5, "status"))
    assert out[0]["ok"] is False and out[0]["id"] is None
    assert out[1]["ok"] is False and out[1]["id"] is None
    assert out[2]["ok"] is False and out[2]["id"] == 4
    assert out[3] == {"id": 5, "ok": True, "data": {}}


async def test_handler_exception_answers_with_error():
    async def handler(op, args):
        raise RuntimeError("boom")

    [r, other] = await run(StubRouter(handler), req(1, "x"), req(2, "x"))
    assert r["id"] == 1 and r["ok"] is False and "boom" in r["error"]
    assert "code" not in r
    assert other["id"] == 2 and other["ok"] is False


async def test_not_found_has_code():
    async def handler(op, args):
        raise NotFound("no data for ZZZZ")

    [r] = await run(StubRouter(handler), req(9, "underlying"))
    assert r == {"id": 9, "ok": False, "error": "no data for ZZZZ", "code": "not_found"}


async def test_nan_in_result_answers_with_error():
    async def handler(op, args):
        return {"x": float("nan")}

    [r] = await run(StubRouter(handler), req(3, "x"))
    assert r["id"] == 3 and r["ok"] is False


async def test_requests_can_finish_out_of_order():
    async def handler(op, args):
        if op == "chain":
            await asyncio.sleep(0.05)
        return {"op": op}

    out = await run(StubRouter(handler), req(1, "chain"), req(2, "status"))
    assert [o["id"] for o in out] == [2, 1]
    assert [o["data"]["op"] for o in out] == ["status", "chain"]


def test_library_print_cannot_corrupt_protocol():
    stdin = req(1, "status") + "\n" + "garbage\n" + req(2, "chain") + "\n"
    proc = subprocess.run(
        [sys.executable, str(HERE / "stub_main.py")], input=stdin,
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    parsed = [json.loads(line) for line in proc.stdout.splitlines()]  # all JSON
    assert len(parsed) == 3
    assert {p["id"] for p in parsed if p["ok"]} == {1, 2}
    assert "noise from a library" in proc.stderr
    assert "stub started" in proc.stderr and "stub stopped" in proc.stderr


def test_stderr_is_utf8_even_when_the_console_encoding_is_not():
    env = {**os.environ, "PYTHONIOENCODING": "cp1252"}  # what a piped stderr gets on Windows
    proc = subprocess.run(
        [sys.executable, str(HERE / "stub_main.py")], input=(req(1, "status") + "\n").encode(),
        capture_output=True, timeout=30, env=env,
    )
    assert proc.returncode == 0
    assert "café in a log line".encode("utf-8") in proc.stderr


def test_invalid_utf8_bytes_get_an_error_line_and_serving_continues():
    nl = bytes([10])
    stdin = (req(1, "status").encode() + nl + b'{"id": 2, ' + bytes([0xFF, 0xFE]) + b"}" + nl
             + req(3, "status").encode() + nl)
    proc = subprocess.run(
        [sys.executable, str(HERE / "stub_main.py")], input=stdin,
        capture_output=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    parsed = [json.loads(line) for line in proc.stdout.decode().splitlines()]
    assert len(parsed) == 3
    assert {p["id"] for p in parsed if p["ok"]} == {1, 3}
    [bad] = [p for p in parsed if not p["ok"]]
    assert bad["id"] is None


class BrokenOut:
    def write(self, text):
        raise BrokenPipeError("pipe closed")

    def flush(self):
        pass


class LifecycleRouter:
    def __init__(self):
        self.stopped = False

    async def start(self):
        pass

    async def stop(self):
        self.stopped = True

    async def handle(self, op, args):
        return {}


async def test_broken_pipe_on_write_begins_shutdown():
    release = threading.Event()

    def stream():  # one request, then stdin stays open
        yield req(1, "status") + chr(10)
        release.wait(10)

    router = LifecycleRouter()
    try:
        await asyncio.wait_for(_main(lambda: router, stream(), BrokenOut()), 3)
    finally:
        release.set()
    assert router.stopped


async def test_an_unexpected_failure_of_serve_is_logged_and_shuts_down(monkeypatch, caplog):
    async def broken_serve(*_args):
        raise RuntimeError("serve broke")

    monkeypatch.setattr(main_module, "serve", broken_serve)
    router = LifecycleRouter()

    with caplog.at_level(logging.ERROR, logger="sidecar.main"):
        await asyncio.wait_for(_main(lambda: router, iter(()), BrokenOut()), 3)

    assert "serve broke" in caplog.text
    assert router.stopped


async def test_a_normal_end_of_input_logs_no_error(caplog):
    router = LifecycleRouter()

    with caplog.at_level(logging.ERROR, logger="sidecar.main"):
        await asyncio.wait_for(_main(lambda: router, iter(()), BrokenOut()), 3)

    assert caplog.text == ""
    assert router.stopped
