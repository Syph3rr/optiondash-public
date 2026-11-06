"""DEPRECATED single-portfolio endpoints, kept as aliases for the first IBKR account.

Before accounts (schema v5) there was one saved snapshot. Today's Portfolio page and Home card
still call these; they act on accounts.first_ibkr_id() (the oldest IBKR account). New code
uses /api/journal/accounts/{id}/snapshot (routes/accounts.py). Remove once nothing calls them.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import accounts
from ..deps import get_conn, ok
from ..portfolio import CsvUpload, TwsSave
from ..repo import NotFound
from .accounts import clear_snapshot, read_snapshot, save_tws, upload_csv

router = APIRouter()

Conn = Depends(get_conn)


def _first_ibkr(conn: sqlite3.Connection) -> int:
    found = accounts.first_ibkr_id(conn)
    if found is None:
        raise NotFound("there is no IBKR account; add one in Settings")
    return found


@router.get("/portfolio")
def get_snapshot(conn: sqlite3.Connection = Conn) -> dict:
    found = accounts.first_ibkr_id(conn)
    return ok(None) if found is None else read_snapshot(found, conn)


@router.post("/portfolio/csv")
def upload_csv_alias(body: CsvUpload, conn: sqlite3.Connection = Conn) -> dict:
    return upload_csv(_first_ibkr(conn), body, conn)


@router.put("/portfolio/tws")
def save_tws_alias(body: TwsSave, conn: sqlite3.Connection = Conn) -> dict:
    return save_tws(_first_ibkr(conn), body, conn)


@router.delete("/portfolio")
def clear(conn: sqlite3.Connection = Conn) -> dict:
    found = accounts.first_ibkr_id(conn)
    return ok(None) if found is None else clear_snapshot(found, conn)
