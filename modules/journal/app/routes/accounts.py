"""Accounts (list, create, update, delete) and each account's saved portfolio snapshot."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Query

from .. import accounts, portfolio
from ..accounts import AccountCreate, AccountUpdate
from ..deps import get_conn, ok
from ..portfolio import CsvUpload, TwsSave

router = APIRouter(prefix="/accounts")

Conn = Depends(get_conn)


@router.get("")
def list_accounts(conn: sqlite3.Connection = Conn) -> dict:
    return ok(accounts.list_accounts(conn))


@router.post("", status_code=201)
def create_account(body: AccountCreate, conn: sqlite3.Connection = Conn) -> dict:
    return ok(accounts.get_account(conn, accounts.create_account(conn, body)))


@router.get("/{account_id}")
def get_account(account_id: int, conn: sqlite3.Connection = Conn) -> dict:
    return ok(accounts.get_account(conn, account_id))


@router.put("/{account_id}")
def update_account(account_id: int, body: AccountUpdate, conn: sqlite3.Connection = Conn) -> dict:
    accounts.update_account(conn, account_id, body)
    return ok(accounts.get_account(conn, account_id))


@router.delete("/{account_id}")
def delete_account(account_id: int, move_to: int | None = Query(default=None, ge=1),
                   conn: sqlite3.Connection = Conn) -> dict:
    return ok(accounts.delete_account(conn, account_id, move_to))


# ---------------------------------------------------------------- snapshots

@router.get("/{account_id}/snapshot")
def read_snapshot(account_id: int, conn: sqlite3.Connection = Conn) -> dict:
    accounts.get_account(conn, account_id)  # 404 for an unknown account
    return ok(portfolio.get_snapshot(conn, account_id))


@router.post("/{account_id}/snapshot/csv")
def upload_csv(account_id: int, body: CsvUpload, conn: sqlite3.Connection = Conn) -> dict:
    accounts.snapshot_account(conn, account_id, "csv")
    positions = portfolio.parse_csv(body.csv)  # ValueError -> 400 with every bad row named
    portfolio.save_snapshot(conn, account_id, "csv", positions, portfolio.cash_rows(body.cash))
    return ok(portfolio.get_snapshot(conn, account_id))


@router.put("/{account_id}/snapshot/tws")
def save_tws(account_id: int, body: TwsSave, conn: sqlite3.Connection = Conn) -> dict:
    accounts.snapshot_account(conn, account_id, "tws")
    rows = None if body.accounts is None else [a.model_dump() for a in body.accounts]
    portfolio.save_snapshot(conn, account_id, "tws", [p.as_dict() for p in body.positions], rows)
    return ok(portfolio.get_snapshot(conn, account_id))


@router.delete("/{account_id}/snapshot")
def clear_snapshot(account_id: int, conn: sqlite3.Connection = Conn) -> dict:
    accounts.get_account(conn, account_id)
    portfolio.clear_snapshot(conn, account_id)
    return ok(None)
