"""Data access. All SQL lives here; every query is parameterised."""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import date
from typing import Any

from .models import (
    EventIn, ExecutionUpdate, FillIn, LegIn, MarkIn, Tag, TradeCreate, TradeUpdate, when_iso,
)

JOURNAL_COLS = (
    "underlying_entry", "iv_entry", "iv_rank_entry", "max_risk_override", "setup", "thesis",
    "planned_exit", "profit_target", "stop_loss", "confidence", "review_right", "review_wrong",
    "lessons", "notes",
)
HEADER_COLS = ("underlying", "strategy", "opened_at")


class NotFound(LookupError):
    pass


CLOSING_EVENTS = frozenset({"close", "expire", "assign"})
EPS = 1e-9


def _iso(v: Any) -> Any:
    return when_iso(v) if isinstance(v, date) else v


# ---------- writes ----------------------------------------------------------------------

def create_trade(conn: sqlite3.Connection, data: TradeCreate, account_id: int,
                 source: str = "manual") -> int:
    """account_id must already be resolved and checked (accounts.resolve)."""
    cols = HEADER_COLS + JOURNAL_COLS + ("source", "account_id")
    values = [_iso(getattr(data, c)) for c in HEADER_COLS + JOURNAL_COLS] + [source, account_id]
    with conn:
        cur = conn.execute(
            f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", values
        )
        trade_id = cur.lastrowid
        _write_tags(conn, trade_id, data.tags)
        _write_fills(conn, trade_id, "open", data.opened_at.isoformat(), data.fills)
        for event in chronological(data.events):
            _write_fills(conn, trade_id, event.event, when_iso(event.executed_at), event.fills)
    return trade_id


def chronological(events: list[EventIn]) -> list[EventIn]:
    """Oldest day first; events on the same day keep the order given. The ledger orders fills
    by (day, execution id), so writing in this order keeps average-cost P&L right."""
    return sorted(events, key=lambda e: when_iso(e.executed_at)[:10])


def insert_trade_header(
    conn: sqlite3.Connection, underlying: str, strategy: str, opened_at: str, source: str,
    account_id: int,
) -> int:
    """Bare trade row (journal left empty). Caller owns the transaction."""
    cur = conn.execute(
        "INSERT INTO trades (underlying, strategy, opened_at, source, account_id) VALUES (?, ?, ?, ?, ?)",
        (underlying, strategy, opened_at, source, account_id))
    return cur.lastrowid


def update_trade(conn: sqlite3.Connection, trade_id: int, data: TradeUpdate) -> None:
    _require_trade(conn, trade_id)
    changes = {c: _iso(v) for c, v in data.model_dump(exclude_unset=True).items() if c != "tags"}
    with conn:
        if changes:
            sets = ", ".join(f"{c} = ?" for c in changes)
            conn.execute(
                f"UPDATE trades SET {sets}, updated_at = datetime('now') WHERE id = ?",
                [*changes.values(), trade_id],
            )
        if data.tags is not None:
            conn.execute("DELETE FROM trade_tags WHERE trade_id = ?", (trade_id,))
            _write_tags(conn, trade_id, data.tags)


def delete_trade(conn: sqlite3.Connection, trade_id: int) -> list[str]:
    """Deletes the trade; returns screenshot filenames so the caller can remove the files."""
    _require_trade(conn, trade_id)
    files = [r[0] for r in conn.execute(
        "SELECT filename FROM screenshots WHERE trade_id = ?", (trade_id,))]
    with conn:
        conn.execute(
            "UPDATE ibkr_fills SET status = 'pending' WHERE exec_id IN (SELECT e.ibkr_exec_id "
            "FROM executions e JOIN legs l ON l.id = e.leg_id WHERE l.trade_id = ?)", (trade_id,))
        conn.execute("DELETE FROM trades WHERE id = ?", (trade_id,))
    return files


def add_event(conn: sqlite3.Connection, trade_id: int, data: EventIn) -> None:
    _require_trade(conn, trade_id)
    with conn:
        _write_fills(conn, trade_id, data.event, when_iso(data.executed_at), data.fills)
        _touch(conn, trade_id)


def add_fill_raw(
    conn: sqlite3.Connection, trade_id: int, leg: LegIn, event: str, executed_at: str,
    qty: float, price: float, commission: float, ibkr_exec_id: str | None = None,
    con_id: int | None = None,
) -> None:
    """Used by the IBKR importer; caller owns the transaction."""
    leg_id = find_or_create_leg(conn, trade_id, leg, con_id)
    check_closing(conn, leg_id, qty, event)
    conn.execute(
        "INSERT INTO executions (leg_id, executed_at, qty, price, commission, event, ibkr_exec_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (leg_id, executed_at, qty, price, commission, event, ibkr_exec_id),
    )


def update_execution(conn: sqlite3.Connection, exec_id: int, data: ExecutionUpdate) -> None:
    changes = {c: _iso(v) for c, v in data.model_dump(exclude_unset=True).items()}
    if not changes:
        return
    with conn:
        sets = ", ".join(f"{c} = ?" for c in changes)
        cur = conn.execute(f"UPDATE executions SET {sets} WHERE id = ?", [*changes.values(), exec_id])
        if cur.rowcount == 0:
            raise NotFound(f"execution {exec_id} not found")


def delete_execution(conn: sqlite3.Connection, exec_id: int) -> None:
    row = conn.execute(
        "SELECT leg_id, ibkr_exec_id FROM executions WHERE id = ?", (exec_id,)).fetchone()
    if row is None:
        raise NotFound(f"execution {exec_id} not found")
    with conn:
        conn.execute("DELETE FROM executions WHERE id = ?", (exec_id,))
        if row["ibkr_exec_id"]:
            conn.execute("UPDATE ibkr_fills SET status = 'pending' WHERE exec_id = ?",
                         (row["ibkr_exec_id"],))
        conn.execute(
            "DELETE FROM legs WHERE id = ? AND NOT EXISTS "
            "(SELECT 1 FROM executions WHERE leg_id = ?)", (row["leg_id"], row["leg_id"]))


def add_mark(conn: sqlite3.Connection, trade_id: int, data: MarkIn) -> None:
    _require_trade(conn, trade_id)
    with conn:
        conn.execute(
            "INSERT INTO marks (trade_id, marked_at, position_value, underlying_price) "
            "VALUES (?, ?, ?, ?)",
            (trade_id, data.marked_at.isoformat(), data.position_value, data.underlying_price))


def delete_mark(conn: sqlite3.Connection, mark_id: int) -> None:
    with conn:
        if conn.execute("DELETE FROM marks WHERE id = ?", (mark_id,)).rowcount == 0:
            raise NotFound(f"mark {mark_id} not found")


def add_screenshot(conn: sqlite3.Connection, trade_id: int, filename: str, caption: str | None) -> int:
    """Caller owns the transaction, so the row can be rolled back if saving the file fails."""
    _require_trade(conn, trade_id)
    cur = conn.execute(
        "INSERT INTO screenshots (trade_id, filename, caption) VALUES (?, ?, ?)",
        (trade_id, filename, caption))
    return cur.lastrowid


def delete_screenshot(conn: sqlite3.Connection, shot_id: int) -> str:
    row = conn.execute("SELECT filename FROM screenshots WHERE id = ?", (shot_id,)).fetchone()
    if row is None:
        raise NotFound(f"screenshot {shot_id} not found")
    with conn:
        conn.execute("DELETE FROM screenshots WHERE id = ?", (shot_id,))
    return row["filename"]


# ---------- helpers ---------------------------------------------------------------------

def _leg_label(conn: sqlite3.Connection, leg_id: int) -> str:
    r = conn.execute("SELECT kind, strike, expiry FROM legs WHERE id = ?", (leg_id,)).fetchone()
    return "stock" if r["kind"] == "stock" else f"{r['strike']:g} {r['kind']} {r['expiry']}"


def check_closing(conn: sqlite3.Connection, leg_id: int, qty: float, event: str) -> None:
    """A close/expire/assign fill may only shrink what is open on that leg.
    Adjustments and rolls may add, reduce or flip freely."""
    if event not in CLOSING_EVENTS:
        return
    net = conn.execute(
        "SELECT COALESCE(SUM(qty), 0) FROM executions WHERE leg_id = ?", (leg_id,)).fetchone()[0]
    label = _leg_label(conn, leg_id)
    if abs(net) < EPS:
        raise ValueError(f"{label}: nothing open to {event}")
    if (qty > 0) == (net > 0):
        raise ValueError(f"{label}: this {event} adds to the position; log it as an adjustment")
    if abs(qty) > abs(net) + EPS:
        raise ValueError(f"{label}: {event} of {abs(qty):g} but only {abs(net):g} open")


def _require_trade(conn: sqlite3.Connection, trade_id: int) -> None:
    if conn.execute("SELECT 1 FROM trades WHERE id = ?", (trade_id,)).fetchone() is None:
        raise NotFound(f"trade {trade_id} not found")


def _touch(conn: sqlite3.Connection, trade_id: int) -> None:
    conn.execute("UPDATE trades SET updated_at = datetime('now') WHERE id = ?", (trade_id,))


def _write_tags(conn: sqlite3.Connection, trade_id: int, tags: list[Tag]) -> None:
    conn.executemany(
        "INSERT OR IGNORE INTO trade_tags (trade_id, kind, value) VALUES (?, ?, ?)",
        [(trade_id, t.kind, t.value.lower()) for t in tags])


def find_or_create_leg(
    conn: sqlite3.Connection, trade_id: int, leg: LegIn, con_id: int | None = None
) -> int:
    expiry = leg.expiry.isoformat() if leg.expiry else None
    row = conn.execute(
        "SELECT id FROM legs WHERE trade_id = ? AND kind = ? AND strike IS ? AND expiry IS ? "
        "AND multiplier = ?",
        (trade_id, leg.kind, leg.strike, expiry, leg.resolved_multiplier)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO legs (trade_id, kind, strike, expiry, multiplier, ibkr_con_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (trade_id, leg.kind, leg.strike, expiry, leg.resolved_multiplier, con_id))
    return cur.lastrowid


def _write_fills(
    conn: sqlite3.Connection, trade_id: int, event: str, executed_at: str, fills: list[FillIn]
) -> None:
    for fill in fills:
        if fill.leg is not None:
            leg_id = find_or_create_leg(conn, trade_id, fill.leg)
        else:
            owner = conn.execute("SELECT trade_id FROM legs WHERE id = ?", (fill.leg_id,)).fetchone()
            if owner is None or owner["trade_id"] != trade_id:
                raise NotFound(f"leg {fill.leg_id} is not part of trade {trade_id}")
            leg_id = fill.leg_id
        check_closing(conn, leg_id, fill.qty, event)
        conn.execute(
            "INSERT INTO executions (leg_id, executed_at, qty, price, commission, event) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (leg_id, executed_at, fill.qty, fill.price, fill.commission, event))


# ---------- reads -----------------------------------------------------------------------

def load_trades(conn: sqlite3.Connection, trade_id: int | None = None,
                accounts: list[int] | None = None) -> list[dict]:
    """Raw trades with tags, legs (each with executions), marks and screenshots, plus
    account_name. `accounts` keeps only trades in those account ids (None = every account)."""
    clauses, args = [], []
    if trade_id is not None:
        clauses.append("t.id = ?")
        args.append(trade_id)
    if accounts is not None:
        clauses.append(f"t.account_id IN ({','.join('?' * len(accounts))})" if accounts else "0")
        args.extend(accounts)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    trades = [dict(r) for r in conn.execute(
        f"SELECT t.*, a.name AS account_name FROM trades t JOIN accounts a ON a.id = t.account_id "
        f"{where} ORDER BY t.opened_at DESC, t.id DESC", args)]
    if not trades:
        if trade_id is not None:
            raise NotFound(f"trade {trade_id} not found")
        return []
    ids = [t["id"] for t in trades]
    qs = ",".join("?" * len(ids))
    tags, legs, execs, mk, shots = (defaultdict(list) for _ in range(5))
    for r in conn.execute(f"SELECT * FROM trade_tags WHERE trade_id IN ({qs})", ids):
        tags[r["trade_id"]].append({"kind": r["kind"], "value": r["value"]})
    for r in conn.execute(
            f"SELECT e.*, l.trade_id FROM executions e JOIN legs l ON l.id = e.leg_id "
            f"WHERE l.trade_id IN ({qs}) ORDER BY substr(e.executed_at, 1, 10), e.id", ids):
        execs[r["leg_id"]].append(dict(r))
    for r in conn.execute(f"SELECT * FROM legs WHERE trade_id IN ({qs}) ORDER BY id", ids):
        legs[r["trade_id"]].append({**dict(r), "executions": execs[r["id"]]})
    for r in conn.execute(f"SELECT * FROM marks WHERE trade_id IN ({qs}) ORDER BY marked_at, id", ids):
        mk[r["trade_id"]].append(dict(r))
    for r in conn.execute(f"SELECT * FROM screenshots WHERE trade_id IN ({qs}) ORDER BY id", ids):
        shots[r["trade_id"]].append(dict(r))
    return [
        {**t, "tags": tags[t["id"]], "legs": legs[t["id"]], "marks": mk[t["id"]],
         "screenshots": shots[t["id"]]}
        for t in trades
    ]


def tag_vocabulary(conn: sqlite3.Connection) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"tag": [], "emotion": [], "mistake": []}
    for r in conn.execute("SELECT DISTINCT kind, value FROM trade_tags ORDER BY value"):
        out[r["kind"]].append(r["value"])
    return out
