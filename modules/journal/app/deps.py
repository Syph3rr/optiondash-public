"""Shared request dependencies and the JSON response envelope."""
from __future__ import annotations

import sqlite3
from typing import Any, Iterator

from fastapi import Request

from . import db
from .config import Settings


def get_conn(request: Request) -> Iterator[sqlite3.Connection]:
    """One connection per request: sync routes run in a threadpool, so none is shared."""
    conn = db.connect(request.app.state.settings.db_path)
    try:
        yield conn
    finally:
        conn.close()


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def ok(data: Any = None) -> dict:
    """Every API response is {ok, data, error}."""
    return {"ok": True, "data": data, "error": None}


def fail(message: str) -> dict:
    return {"ok": False, "data": None, "error": message}
