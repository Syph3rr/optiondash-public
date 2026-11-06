"""Start the journal service on 127.0.0.1 (TRADELOG_PORT, default 8000).

The supported way to run it is behind the OptionDash gateway (`cargo run` at the repo
root), which starts this process and serves the shared theme, nav and pricing engine.
The gateway sets JOURNAL_PARENT_WATCH=1 so this process exits when the gateway does.
"""
from __future__ import annotations

import logging
import os
import sys

import uvicorn

from app import parentwatch
from app.main import create_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    port = int(os.environ.get("TRADELOG_PORT", "8000"))
    server = uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port))
    if parentwatch.enabled(os.environ):
        parentwatch.watch(sys.stdin.buffer, lambda: setattr(server, "should_exit", True))
    server.run()


if __name__ == "__main__":
    main()
