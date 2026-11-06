"""stdio entry point: one JSON request per line in, one JSON response per line out."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
from typing import AsyncIterator, Callable

from errors import CodedError, NotFound

SHUTDOWN_GRACE = 2.0
NOT_FOUND_CODE = "not_found"
NEWLINE = chr(10)

log = logging.getLogger("sidecar.main")


def _encode(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":"), allow_nan=False)


def _error(id_, exc: BaseException) -> dict:
    """The error reply. `code` is set for failures the gateway maps to a status:
    not_found, and the broker's not_connected / timeout / busy."""
    out = {"id": id_, "ok": False, "error": str(exc) or type(exc).__name__}
    if isinstance(exc, NotFound):
        out["code"] = NOT_FOUND_CODE
    elif isinstance(exc, CodedError):
        out["code"] = exc.code
    return out


def _parse(line: str) -> tuple[object, str, dict]:
    request = json.loads(line)
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    id_ = request.get("id")
    op = request.get("op")
    if not isinstance(op, str):
        raise _BadRequest(id_, "request needs an op")
    return id_, op, request.get("args") or {}


class _BadRequest(ValueError):
    def __init__(self, id_, message: str):
        super().__init__(message)
        self.id = id_


async def _answer(line: str, router) -> dict:
    id_ = None
    try:
        id_, op, args = _parse(line)
        return {"id": id_, "ok": True, "data": await router.handle(op, args)}
    except _BadRequest as exc:
        return _error(exc.id, exc)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if not isinstance(exc, (ValueError, NotFound)):
            log.exception("request %r failed", id_)
        return _error(id_, exc)


async def _respond(line: str, write_line: Callable[[str], None], router) -> None:
    response = await _answer(line, router)
    try:
        text = _encode(response)
    except ValueError as exc:  # NaN or similar in a result
        text = _encode(_error(response.get("id"), exc))
    write_line(text)


async def serve(
    reader_lines: AsyncIterator[str], write_line: Callable[[str], None], router
) -> None:
    """Answers every request as its own task, so a slow one never blocks the rest."""
    tasks: set[asyncio.Task] = set()
    async for line in reader_lines:
        if not line.strip():
            continue
        task = asyncio.create_task(_respond(line, write_line, router))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    if tasks:
        _, pending = await asyncio.wait(tasks, timeout=SHUTDOWN_GRACE)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


def _read_stdin(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, stream) -> None:
    try:
        for line in stream:
            loop.call_soon_threadsafe(queue.put_nowait, line)
    except Exception:
        log.exception("reading stdin failed")
    finally:
        try:
            loop.call_soon_threadsafe(queue.put_nowait, None)
        except RuntimeError:  # loop already closed
            pass


async def _stdin_lines(stream) -> AsyncIterator[str]:
    queue: asyncio.Queue = asyncio.Queue()
    thread = threading.Thread(
        target=_read_stdin, args=(asyncio.get_running_loop(), queue, stream), daemon=True)
    thread.start()
    while (line := await queue.get()) is not None:
        yield line


async def _main(router_factory: Callable[[], object], stream, protocol_out) -> None:
    router = router_factory()
    stop = asyncio.Event()

    def write_line(text: str) -> None:
        try:
            protocol_out.write(text + NEWLINE)
            protocol_out.flush()
        except (OSError, ValueError) as exc:  # the reader of our stdout is gone
            if not stop.is_set():
                log.error("cannot write to stdout, shutting down: %r", exc)
            stop.set()

    await router.start()
    serving = asyncio.create_task(serve(_stdin_lines(stream), write_line, router))
    stopping = asyncio.create_task(stop.wait())
    try:
        await asyncio.wait({serving, stopping}, return_when=asyncio.FIRST_COMPLETED)
        if serving.done() and not serving.cancelled() and serving.exception() is not None:
            log.error("serving stopped on an unexpected error", exc_info=serving.exception())
    finally:
        for task in (serving, stopping):
            task.cancel()
        await asyncio.gather(serving, stopping, return_exceptions=True)
        await router.stop()


def build_router():
    """Imported late: the libraries behind these must load after stdout is redirected."""
    from ibkr import IbkrSource
    from router import Router
    from yahoo import YahooSource

    return Router(IbkrSource(), YahooSource())


def run(router_factory: Callable[[], object]) -> None:
    protocol_out = sys.stdout
    sys.stdout = sys.stderr  # a stray print() must not reach the protocol stream
    logging.basicConfig(
        stream=sys.stderr, level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # the Rust parent reads logs as UTF-8
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")  # bad bytes: an error line, not EOF
    protocol_out.reconfigure(encoding="utf-8", newline="\n")
    asyncio.run(_main(router_factory, sys.stdin, protocol_out))


if __name__ == "__main__":
    run(build_router)
