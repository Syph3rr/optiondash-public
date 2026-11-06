"""Accounts: where a trade lives and where its positions come from.

Three types, each with the sources it may read positions from:
  ibkr  -> tws              (TWS live; a saved snapshot or CSV upload is the fallback)
  paper -> journal          (positions are the journal's own open trades)
  other -> csv | journal    (another broker: CSV upload, or the journal)

Every trade has exactly one account (trades.account_id). Each account may keep one saved
portfolio snapshot (see portfolio.py). The database CHECKs repeat these rules.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException, Query
from pydantic import Field, field_validator, model_validator

from .models import Strict
from .repo import NotFound

NAME_MAX = 40
REF_PATTERN = r"^[A-Za-z0-9._-]{1,32}$"
MAX_FILTER_IDS = 200
MAX_MOVE = 5000

AccountType = Literal["ibkr", "paper", "other"]
Source = Literal["tws", "csv", "journal"]
SOURCES: dict[str, tuple[str, ...]] = {"ibkr": ("tws",), "paper": ("journal",), "other": ("csv", "journal")}
DEFAULT_SOURCE = {"ibkr": "tws", "paper": "journal", "other": "csv"}

# A trade is open unless it has fills and every leg nets to zero (as views.build_view says).
_OPEN_TRADE = (
    "(NOT EXISTS (SELECT 1 FROM legs l JOIN executions e ON e.leg_id = l.id WHERE l.trade_id = t.id)"
    " OR EXISTS (SELECT 1 FROM legs l WHERE l.trade_id = t.id AND"
    " abs((SELECT COALESCE(SUM(e.qty), 0) FROM executions e WHERE e.leg_id = l.id)) >= 1e-9))"
)
_LIST_SQL = (
    "SELECT a.id, a.name, a.type, a.source, a.broker_ref, a.sort_order, a.created_at,"
    " (SELECT count(*) FROM trades t WHERE t.account_id = a.id) AS trades,"
    f" (SELECT count(*) FROM trades t WHERE t.account_id = a.id AND {_OPEN_TRADE}) AS open_trades,"
    " s.source AS snap_source, s.saved_at AS snap_saved_at,"
    " json_array_length(s.positions) AS snap_positions"
    " FROM accounts a LEFT JOIN portfolio_snapshot s ON s.account_id = a.id"
)


class Conflict(RuntimeError):
    """The request clashes with what is saved (answered with 409 and this message)."""


# ---------------------------------------------------------------- request shapes

def _check_name(v: str | None) -> str | None:
    if v is not None and any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
        raise ValueError("name cannot contain control characters")
    return v


def _upper(v: str | None) -> str | None:
    return v.upper() if v is not None else None  # IBKR account numbers are upper case


class AccountCreate(Strict):
    name: str = Field(min_length=1, max_length=NAME_MAX)
    type: AccountType
    source: Source | None = None          # left out: tws / journal / csv by type
    broker_ref: str | None = Field(default=None, pattern=REF_PATTERN)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return _check_name(v)

    @field_validator("broker_ref")
    @classmethod
    def _ref(cls, v: str | None) -> str | None:
        return _upper(v)


class AccountUpdate(Strict):
    """Partial update. The type is fixed once created. broker_ref: null clears it."""
    name: str | None = Field(default=None, min_length=1, max_length=NAME_MAX)
    source: Source | None = None
    broker_ref: str | None = Field(default=None, pattern=REF_PATTERN)
    sort_order: int | None = Field(default=None, ge=-1_000_000, le=1_000_000)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return _check_name(v)

    @field_validator("broker_ref")
    @classmethod
    def _ref(cls, v: str | None) -> str | None:
        return _upper(v)

    @field_validator("name", "source", "sort_order", mode="before")
    @classmethod
    def _not_null(cls, v: object) -> object:
        if v is None:
            raise ValueError("cannot be empty; leave it out to keep the current value")
        return v

    @model_validator(mode="after")
    def _something(self) -> "AccountUpdate":
        if not self.model_fields_set:
            raise ValueError("send name, source, broker_ref or sort_order to change")
        return self


class TradeMove(Strict):
    trade_ids: list[int] = Field(min_length=1, max_length=MAX_MOVE)
    account_id: int


# ---------------------------------------------------------------- the ?accounts= filter

def parse_filter(raw: str | None) -> list[int] | None:
    """`?accounts=1,2` as ids; None (all accounts) when absent. Raises ValueError when empty
    or not a list of positive whole numbers. Unknown ids are allowed and match nothing."""
    if raw is None:
        return None
    parts = [p.strip() for p in raw.split(",")]
    if not raw.strip() or any(not p.isdigit() or int(p) < 1 for p in parts):
        raise ValueError("accounts must be a comma-separated list of account ids, such as accounts=1,2; "
                         "leave it out for all accounts")
    if len(parts) > MAX_FILTER_IDS:
        raise ValueError(f"accounts: at most {MAX_FILTER_IDS} ids")
    return sorted({int(p) for p in parts})


def account_filter(accounts: str | None = Query(default=None)) -> list[int] | None:
    """FastAPI dependency for `?accounts=`; a bad value is a 422 in the usual envelope."""
    try:
        return parse_filter(accounts)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---------------------------------------------------------------- lookups

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _item(row: sqlite3.Row) -> dict:
    out = {k: row[k] for k in ("id", "name", "type", "source", "broker_ref", "sort_order", "created_at",
                               "trades", "open_trades")}
    out["snapshot"] = None if row["snap_source"] is None else {
        "source": row["snap_source"], "saved_at": row["snap_saved_at"], "positions": row["snap_positions"]}
    return out


def list_accounts(conn: sqlite3.Connection) -> list[dict]:
    return [_item(r) for r in conn.execute(f"{_LIST_SQL} ORDER BY a.sort_order, a.id")]


def get_account(conn: sqlite3.Connection, account_id: int) -> dict:
    row = conn.execute(f"{_LIST_SQL} WHERE a.id = ?", (account_id,)).fetchone()
    if row is None:
        raise NotFound(f"account {account_id} not found")
    return _item(row)


def _row(conn: sqlite3.Connection, account_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if row is None:
        raise NotFound(f"account {account_id} not found")
    return row


def require(conn: sqlite3.Connection, account_id: int) -> None:
    """An account named in a request body must exist (ValueError -> 400)."""
    if conn.execute("SELECT 1 FROM accounts WHERE id = ?", (account_id,)).fetchone() is None:
        raise ValueError(f"account {account_id} does not exist")


def first_ibkr_id(conn: sqlite3.Connection) -> int | None:
    """The IBKR account the old single-portfolio endpoints mean: the oldest one (lowest id),
    so reordering accounts never changes it."""
    row = conn.execute("SELECT id FROM accounts WHERE type = 'ibkr' ORDER BY id LIMIT 1").fetchone()
    return row[0] if row else None


def default_id(conn: sqlite3.Connection) -> int:
    """Where a trade goes when no account is given: the first IBKR account, else the lowest id."""
    found = first_ibkr_id(conn)
    if found is not None:
        return found
    row = conn.execute("SELECT id FROM accounts ORDER BY id LIMIT 1").fetchone()
    if row is None:  # unreachable through the API: the last account cannot be deleted
        raise Conflict("there are no accounts; add one first")
    return row[0]


def resolve(conn: sqlite3.Connection, account_id: int | None) -> int:
    if account_id is None:
        return default_id(conn)
    require(conn, account_id)
    return account_id


def ibkr_for_broker_ref(conn: sqlite3.Connection, broker_ref: str) -> int | None:
    if not broker_ref:
        return None
    row = conn.execute(
        "SELECT id FROM accounts WHERE type = 'ibkr' AND broker_ref = ? COLLATE NOCASE ORDER BY id LIMIT 1",
        (broker_ref,)).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------- writes

def _check_unique(conn: sqlite3.Connection, account_id: int | None, name: str | None,
                  broker_ref: str | None) -> None:
    other = -1 if account_id is None else account_id
    if name is not None and conn.execute(
            "SELECT 1 FROM accounts WHERE name = ? COLLATE NOCASE AND id <> ?", (name, other)).fetchone():
        raise Conflict(f"an account named '{name}' already exists")
    if broker_ref is not None and conn.execute(
            "SELECT 1 FROM accounts WHERE broker_ref = ? COLLATE NOCASE AND id <> ?",
            (broker_ref, other)).fetchone():
        raise Conflict(f"another account already has the IBKR account number {broker_ref}")


def _check_source(type_: str, source: str) -> None:
    if source not in SOURCES[type_]:
        allowed = " or ".join(SOURCES[type_])
        raise ValueError(f"source: a {type_} account reads its positions from {allowed}, not {source}")


def create_account(conn: sqlite3.Connection, body: AccountCreate) -> int:
    source = body.source or DEFAULT_SOURCE[body.type]
    _check_source(body.type, source)
    _check_unique(conn, None, body.name, body.broker_ref)
    with conn:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO accounts (name, type, source, broker_ref, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (body.name, body.type, source, body.broker_ref, order, _now()))
    return cur.lastrowid


def update_account(conn: sqlite3.Connection, account_id: int, body: AccountUpdate) -> None:
    row = _row(conn, account_id)
    changes = body.model_dump(include=body.model_fields_set)
    if "source" in changes:
        _check_source(row["type"], changes["source"])
    _check_unique(conn, account_id, changes.get("name"), changes.get("broker_ref"))
    sets = ", ".join(f"{col} = ?" for col in changes)  # names come from the model, never input
    with conn:
        conn.execute(f"UPDATE accounts SET {sets} WHERE id = ?", (*changes.values(), account_id))


def delete_account(conn: sqlite3.Connection, account_id: int, move_to: int | None) -> dict:
    """Deletes the account (its snapshot goes with it). Its trades must move first: give
    move_to, or get a 409. The last account cannot be deleted."""
    row = _row(conn, account_id)
    if conn.execute("SELECT count(*) FROM accounts").fetchone()[0] <= 1:
        raise Conflict("you can't delete the last account; add another one first")
    count = conn.execute("SELECT count(*) FROM trades WHERE account_id = ?", (account_id,)).fetchone()[0]
    if move_to is not None:
        if move_to == account_id:
            raise ValueError("move_to: can't move the trades to the account being deleted (itself)")
        require(conn, move_to)
    elif count:
        noun, it = ("trade", "it") if count == 1 else ("trades", "them")
        raise Conflict(f"'{row['name']}' has {count} {noun}; move {it} to another account first "
                       f"(or delete with ?move_to=<account id>)")
    with conn:
        if move_to is not None:
            conn.execute("UPDATE trades SET account_id = ?, updated_at = datetime('now') WHERE account_id = ?",
                         (move_to, account_id))
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    return {"deleted": account_id, "moved": count if move_to is not None else 0}


def move_trades(conn: sqlite3.Connection, body: TradeMove) -> dict:
    """Moves every given trade to the account in one transaction, or none of them."""
    require(conn, body.account_id)
    ids = sorted(set(body.trade_ids))
    marks = ",".join("?" * len(ids))
    found = {r[0] for r in conn.execute(f"SELECT id FROM trades WHERE id IN ({marks})", ids)}
    missing = [i for i in ids if i not in found]
    if missing:
        shown = ", ".join(str(i) for i in missing[:20]) + (" …" if len(missing) > 20 else "")
        raise ValueError(f"no trade(s) with id {shown}; nothing was moved")
    with conn:
        conn.execute(f"UPDATE trades SET account_id = ?, updated_at = datetime('now') WHERE id IN ({marks})",
                     (body.account_id, *ids))
    return {"moved": len(ids), "account_id": body.account_id}


# ---------------------------------------------------------------- snapshot rules

def snapshot_account(conn: sqlite3.Connection, account_id: int, kind: Literal["csv", "tws"]) -> int:
    """Checks the account may hold a snapshot of this kind; returns its id.
    CSV: accounts whose source is csv, or IBKR accounts (as their fallback). TWS: IBKR only."""
    row = _row(conn, account_id)
    if kind == "tws" and row["type"] != "ibkr":
        raise ValueError(f"'{row['name']}' is not an IBKR account; only IBKR accounts save TWS positions")
    if kind == "csv" and not (row["type"] == "ibkr" or row["source"] == "csv"):
        hint = "" if row["type"] == "paper" else "; set its source to csv first"
        raise ValueError(f"'{row['name']}' takes its positions from the journal, so it has no CSV upload{hint}")
    return account_id
