"""Exit when the parent process goes away.

The OptionDash gateway starts this service with its stdin connected to a pipe it keeps
open. When the gateway exits, for any reason, the pipe closes and stdin reaches EOF; the
watcher then asks uvicorn to shut down cleanly. It is opt-in (JOURNAL_PARENT_WATCH=1) so a
run from a terminal, where stdin is the keyboard, is unaffected.
"""
from __future__ import annotations

import logging
import threading
from typing import BinaryIO, Callable, Mapping

log = logging.getLogger(__name__)

ENV_VAR = "JOURNAL_PARENT_WATCH"
CHUNK = 4096


def enabled(env: Mapping[str, str]) -> bool:
    return env.get(ENV_VAR, "").strip() == "1"


def _drain_until_eof(stream: BinaryIO, on_eof: Callable[[], None]) -> None:
    try:
        while stream.read(CHUNK):
            pass  # anything the parent writes is ignored; only EOF matters
    except (OSError, ValueError) as exc:  # a broken or closed pipe means the parent is gone too
        log.info("parent stdin pipe failed (%s); shutting down", exc)
    else:
        log.info("parent closed stdin; shutting down")
    on_eof()


def watch(stream: BinaryIO, on_eof: Callable[[], None]) -> threading.Thread:
    """Read `stream` on a daemon thread and call `on_eof` once it ends."""
    thread = threading.Thread(target=_drain_until_eof, args=(stream, on_eof),
                              name="parent-watch", daemon=True)
    thread.start()
    return thread
