"""Saved analyser set-ups: request validation and data access for the `analyses` table.

The analyser owns the shape of `state` (a versioned JSON object, {"v": 1, ...}); the journal
only stores it, checks it is an object of a sane size, and copies the symbol out for the list.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from pydantic import Field, field_validator, model_validator

from .models import Strict
from .repo import NotFound

NAME_MAX = 80
MAX_STATE_BYTES = 200_000
SYMBOL_MAX = 20
LIST_COLS = "id, name, underlying, updated_at"
ONE_COLS = "id, name, underlying, state, created_at, updated_at"


def _check_name(v: str | None) -> str | None:
    if v is not None and any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
        raise ValueError("name cannot contain control characters")
    return v


def _check_state(v: dict | None) -> dict | None:
    if v is not None and len(_encode(v).encode("utf-8")) > MAX_STATE_BYTES:
        raise ValueError(f"state is too large (over {MAX_STATE_BYTES // 1000} KB)")
    return v


class AnalysisCreate(Strict):
    name: str = Field(min_length=1, max_length=NAME_MAX)
    state: dict[str, Any]

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return _check_name(v)

    @field_validator("state")
    @classmethod
    def _state(cls, v: dict | None) -> dict | None:
        return _check_state(v)


class AnalysisUpdate(Strict):
    name: str | None = Field(default=None, min_length=1, max_length=NAME_MAX)
    state: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return _check_name(v)

    @field_validator("state")
    @classmethod
    def _state(cls, v: dict | None) -> dict | None:
        return _check_state(v)

    @field_validator("name", "state", mode="before")
    @classmethod
    def _not_null(cls, v: object) -> object:
        if v is None:
            raise ValueError("cannot be empty; leave it out to keep the current value")
        return v

    @model_validator(mode="after")
    def _something(self) -> "AnalysisUpdate":
        if self.name is None and self.state is None:
            raise ValueError("send a name or state to change")
        return self


def _encode(state: dict) -> str:
    return json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _underlying(state: dict) -> str | None:
    symbol = state.get("symbol")
    if not isinstance(symbol, str):
        return None
    symbol = symbol.strip().upper()
    return symbol if 0 < len(symbol) <= SYMBOL_MAX else None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(row: sqlite3.Row) -> dict:
    out = dict(row)
    if "state" in out:
        out["state"] = json.loads(out["state"])
    return out


def list_analyses(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(f"SELECT {LIST_COLS} FROM analyses ORDER BY updated_at DESC, id DESC")
    return [dict(r) for r in rows]


def get_analysis(conn: sqlite3.Connection, analysis_id: int) -> dict:
    row = conn.execute(f"SELECT {ONE_COLS} FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
    if row is None:
        raise NotFound(f"analysis {analysis_id} not found")
    return _row(row)


def create_analysis(conn: sqlite3.Connection, body: AnalysisCreate) -> int:
    now = _now()
    with conn:
        cur = conn.execute(
            "INSERT INTO analyses (name, underlying, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (body.name, _underlying(body.state), _encode(body.state), now, now))
    return cur.lastrowid


def update_analysis(conn: sqlite3.Connection, analysis_id: int, body: AnalysisUpdate) -> None:
    changes: dict[str, Any] = {"updated_at": _now()}
    if body.name is not None:
        changes["name"] = body.name
    if body.state is not None:
        changes.update(state=_encode(body.state), underlying=_underlying(body.state))
    sets = ", ".join(f"{col} = ?" for col in changes)  # column names are fixed above, never input
    with conn:
        cur = conn.execute(f"UPDATE analyses SET {sets} WHERE id = ?", (*changes.values(), analysis_id))
    if cur.rowcount == 0:
        raise NotFound(f"analysis {analysis_id} not found")


def delete_analysis(conn: sqlite3.Connection, analysis_id: int) -> None:
    with conn:
        cur = conn.execute("DELETE FROM analyses WHERE id = ?", (analysis_id,))
    if cur.rowcount == 0:
        raise NotFound(f"analysis {analysis_id} not found")
