"""The saved portfolio snapshot: what the Portfolio page shows when TWS is not connected.

Each account keeps at most one snapshot (portfolio_snapshot is keyed by account_id). It comes
from either a CSV upload or the last successful TWS read, and holds positions in the same
shape /api/broker/positions returns, plus the optional account-summary rows of
/api/broker/account. Which accounts may hold which kind is decided in accounts.py.
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import Field, model_validator

from .models import Strict

MAX_ROWS = 500
MAX_CSV_CHARS = 256_000
MAX_ERRORS_SHOWN = 20
SYMBOL_MAX = 20

TYPES = {
    "stock": "stock", "stk": "stock", "share": "stock", "shares": "stock", "equity": "stock",
    "call": "call", "c": "call",
    "put": "put", "p": "put",
}
COLUMNS = ("type", "symbol", "qty", "avg_cost", "strike", "expiry", "multiplier", "trading_class", "account")
REQUIRED = ("type", "symbol", "qty", "avg_cost")
ALIASES = {
    "quantity": "qty", "position": "qty", "avg_price": "avg_cost", "average_cost": "avg_cost",
    "average_price": "avg_cost", "cost": "avg_cost", "expiration": "expiry", "exp": "expiry",
    "class": "trading_class", "mult": "multiplier",
}


# ---------------------------------------------------------------- shapes

class PositionRow(Strict):
    """One position, as /api/broker/positions returns it. avg_cost is per share."""
    account: str = Field(default="", max_length=32)
    symbol: str = Field(min_length=1, max_length=SYMBOL_MAX)
    sec_type: Literal["STK", "OPT"]
    kind: Literal["stock", "call", "put"]
    strike: float | None = Field(default=None, gt=0)
    expiry: date | None = None
    multiplier: int = Field(gt=0, le=10_000)
    con_id: int | None = None
    trading_class: str | None = Field(default=None, max_length=SYMBOL_MAX)
    qty: float
    avg_cost: float

    @model_validator(mode="after")
    def _consistent(self) -> "PositionRow":
        if self.qty == 0:
            raise ValueError("qty cannot be 0")
        if self.sec_type == "STK":
            if self.kind != "stock" or self.strike is not None or self.expiry is not None:
                raise ValueError("a stock row has kind 'stock' and no strike or expiry")
        elif self.kind == "stock" or self.strike is None or self.expiry is None:
            raise ValueError("an option row needs kind call/put, a strike and an expiry")
        return self

    def as_dict(self) -> dict:
        out = self.model_dump()
        out["expiry"] = self.expiry.isoformat() if self.expiry else None
        return out


class AccountRow(Strict):
    """One account-summary row, as /api/broker/account returns it. None means "no figure"."""
    account: str = Field(default="", max_length=32)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    cash: float | None = None
    net_liquidation: float | None = None
    available_funds: float | None = None
    buying_power: float | None = None


class CashIn(Strict):
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    cash: float | None = None
    net_liquidation: float | None = None
    available_funds: float | None = None
    buying_power: float | None = None


class CsvUpload(Strict):
    csv: str = Field(max_length=MAX_CSV_CHARS)
    cash: CashIn | None = None


class TwsSave(Strict):
    positions: list[PositionRow] = Field(max_length=MAX_ROWS)
    # Left out: keep the saved cash (the account read can fail while positions succeed).
    accounts: list[AccountRow] | None = Field(default=None, max_length=50)


# ---------------------------------------------------------------- CSV

def _header(name: str) -> str:
    key = name.strip().lower().replace(" ", "_").replace("-", "_")
    return ALIASES.get(key, key)


def _number(raw: str, column: str, errors: list[str]) -> float | None:
    text = raw.strip().replace("$", "").replace(",", "")
    try:
        value = float(text)
    except ValueError:
        errors.append(f"{column} must be a number (got {raw.strip()!r})")
        return None
    if value != value or value in (float("inf"), float("-inf")):
        errors.append(f"{column} must be a number (got {raw.strip()!r})")
        return None
    return value


def _expiry(raw: str, errors: list[str]) -> str | None:
    text = raw.strip()
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    errors.append(f"expiry must be YYYY-MM-DD (got {text!r})")
    return None


def _option_fields(cells: dict, kind: str, errors: list[str]) -> tuple[float | None, str | None]:
    strike = expiry = None
    if not cells["strike"]:
        errors.append(f"strike is needed for a {kind}")
    else:
        strike = _number(cells["strike"], "strike", errors)
        if strike is not None and strike <= 0:
            errors.append("strike must be above 0")
    if not cells["expiry"]:
        errors.append(f"expiry is needed for a {kind}")
    else:
        expiry = _expiry(cells["expiry"], errors)
    return strike, expiry


def _multiplier(raw: str, default: int, errors: list[str]) -> int:
    if not raw:
        return default
    value = _number(raw, "multiplier", errors)
    if value is None:
        return default
    if value <= 0 or value != int(value):
        errors.append("multiplier must be a whole number above 0")
        return default
    return int(value)


def _row(cells: dict) -> tuple[dict | None, list[str]]:
    """One CSV row as a position dict, or the problems with it."""
    errors: list[str] = []
    symbol = cells["symbol"].upper()
    if not symbol:
        errors.append("symbol is needed")
    elif len(symbol) > SYMBOL_MAX:
        errors.append(f"symbol is longer than {SYMBOL_MAX} characters")
    kind = TYPES.get(cells["type"].lower())
    if kind is None:
        errors.append(f"type must be stock, call or put (got {cells['type']!r})")
    qty = _number(cells["qty"], "qty", errors) if cells["qty"] else errors.append("qty is needed")
    if qty == 0:
        errors.append("qty cannot be 0")
    avg = _number(cells["avg_cost"], "avg_cost", errors) if cells["avg_cost"] else errors.append("avg_cost is needed")
    if avg is not None and avg < 0:
        errors.append("avg_cost cannot be negative (use a negative qty for a short)")

    strike = expiry = None
    if kind == "stock":
        for column in ("strike", "expiry", "trading_class"):
            if cells[column]:
                errors.append(f"leave {column} blank for a stock")
    elif kind is not None:
        strike, expiry = _option_fields(cells, kind, errors)
    multiplier = _multiplier(cells["multiplier"], 1 if kind == "stock" else 100, errors)
    if errors:
        return None, errors
    is_option = kind != "stock"
    return PositionRow(
        account=cells["account"], symbol=symbol, sec_type="OPT" if is_option else "STK", kind=kind,
        strike=strike, expiry=expiry, multiplier=multiplier,
        trading_class=(cells["trading_class"].upper() or symbol) if is_option else None,
        qty=qty, avg_cost=avg,
    ).as_dict(), []


def _identity(p: dict) -> tuple:
    return (p["account"], p["symbol"], p["kind"], p["strike"], p["expiry"], p["trading_class"])


def _raise(errors: list[str]) -> None:
    shown = errors[:MAX_ERRORS_SHOWN]
    more = len(errors) - len(shown)
    raise ValueError("\n".join(shown + ([f"…and {more} more"] if more else [])))


def parse_csv(text: str) -> list[dict]:
    """Positions from a CSV upload. Raises ValueError naming every bad row and column."""
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = next(reader, None)
    if not header or not any(h.strip() for h in header):
        raise ValueError("the file has no positions (it needs a header row and at least one position)")
    columns = [_header(h) for h in header]
    unknown = sorted({c for c in columns if c and c not in COLUMNS})
    missing = sorted(set(REQUIRED) - set(columns))
    problems = ([f"unknown column(s): {', '.join(unknown)}; the columns are {', '.join(COLUMNS)}"] if unknown else []) \
        + ([f"missing column(s): {', '.join(missing)}"] if missing else [])
    if problems:
        _raise(problems)

    positions: list[dict] = []
    errors: list[str] = []
    seen: dict[tuple, int] = {}
    for values in reader:
        line = reader.line_num
        if not any(v.strip() for v in values):
            continue
        if len(positions) + len(errors) >= MAX_ROWS:
            raise ValueError(f"the file has more than {MAX_ROWS} positions; upload at most {MAX_ROWS}")
        cells = {c: "" for c in COLUMNS}
        cells.update({c: v.strip() for c, v in zip(columns, values) if c})
        where = f"row {line}" + (f" ({cells['symbol'].upper()})" if cells["symbol"] else "")
        row, row_errors = _row(cells)
        if row_errors:
            errors.extend(f"{where}: {e}" for e in row_errors)
            continue
        key = _identity(row)
        if key in seen:
            errors.append(f"{where}: same position as row {seen[key]}; combine them into one row")
            continue
        seen[key] = line
        positions.append(row)
    if errors:
        _raise(errors)
    if not positions:
        raise ValueError("the file has no positions (it needs a header row and at least one position)")
    return positions


def cash_rows(cash: CashIn | None) -> list[dict]:
    if cash is None:
        return []
    figures = cash.model_dump(exclude={"currency"})
    if all(v is None for v in figures.values()):
        return []
    return [AccountRow(currency=cash.currency, **figures).model_dump()]


# ---------------------------------------------------------------- storage

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _encode(value: list) -> str:
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def get_snapshot(conn: sqlite3.Connection, account_id: int | None) -> dict | None:
    """The account's snapshot, or None. account_id None (no such account) is None too."""
    if account_id is None:
        return None
    row = conn.execute("SELECT source, saved_at, positions, accounts FROM portfolio_snapshot "
                       "WHERE account_id = ?", (account_id,)).fetchone()
    if row is None:
        return None
    return {"source": row["source"], "saved_at": row["saved_at"],
            "positions": json.loads(row["positions"]), "accounts": json.loads(row["accounts"])}


def save_snapshot(conn: sqlite3.Connection, account_id: int, source: str, positions: list[dict],
                  accounts: list[dict] | None) -> None:
    """Replace the account's snapshot. accounts=None keeps the saved cash rows (or none)."""
    if accounts is None:
        old = get_snapshot(conn, account_id)
        accounts = old["accounts"] if old else []
    with conn:
        conn.execute(
            "INSERT INTO portfolio_snapshot (account_id, source, saved_at, positions, accounts) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(account_id) DO UPDATE SET source = excluded.source, saved_at = excluded.saved_at, "
            "positions = excluded.positions, accounts = excluded.accounts",
            (account_id, source, _now(), _encode(positions), _encode(accounts)))


def clear_snapshot(conn: sqlite3.Connection, account_id: int | None) -> None:
    if account_id is None:
        return
    with conn:
        conn.execute("DELETE FROM portfolio_snapshot WHERE account_id = ?", (account_id,))
