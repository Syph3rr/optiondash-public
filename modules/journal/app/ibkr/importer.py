"""Staging and assigning IBKR fills to trades."""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import date
from typing import Literal

from pydantic import Field, model_validator

from .. import accounts, repo
from ..models import STRATEGIES, LegIn, Strict

COLUMNS = ("exec_id", "order_id", "perm_id", "executed_at", "symbol", "sec_type", "kind",
           "strike", "expiry", "multiplier", "qty", "price", "commission", "commission_known",
           "con_id", "account")


class AssignIn(Strict):
    """New trade: give `strategy` (event is always 'open'). Existing trade: give
    `trade_id` and say what the fills do (`event`), so closes are never logged as opens."""
    exec_ids: list[str] = Field(min_length=1, max_length=100)
    trade_id: int | None = None
    strategy: str | None = None
    event: Literal["open", "adjust", "roll", "close", "expire", "assign"] | None = None

    @model_validator(mode="after")
    def _target(self) -> "AssignIn":
        if (self.trade_id is None) == (self.strategy is None):
            raise ValueError("give trade_id (existing trade) or strategy (new trade)")
        if self.strategy is not None and self.strategy not in STRATEGIES:
            raise ValueError(f"unknown strategy '{self.strategy}'")
        if self.trade_id is not None and self.event is None:
            raise ValueError("event is required when adding fills to an existing trade")
        if self.strategy is not None and self.event not in (None, "open"):
            raise ValueError("event: fills that start a new trade are always 'open'")
        return self


class IgnoreIn(Strict):
    exec_ids: list[str] = Field(min_length=1, max_length=500)
    restore: bool = False


INSERT = (f"INSERT OR IGNORE INTO ibkr_fills ({', '.join(COLUMNS)}) "
          f"VALUES ({', '.join('?' * len(COLUMNS))})")


def _fills_in_commission(old: dict, new: dict) -> bool:
    """A later sync brings a commission the first one missed (TWS reports arrive late).
    It replaces only a value that was never really known: one stored while TWS had not
    reported it, or a 0 from before that was tracked. A known value is never overwritten."""
    if not new.get("commission_known", 1) or new["commission"] == old["commission"]:
        return False
    return not old["commission_known"] or (old["commission"] == 0 and new["commission"] > 0)


def _apply_commission(conn: sqlite3.Connection, exec_id: str, commission: float) -> None:
    conn.execute("UPDATE ibkr_fills SET commission = ?, commission_known = 1 WHERE exec_id = ?",
                 (commission, exec_id))
    # Already assigned: correct the trade's execution too, unless someone edited it since.
    conn.execute("UPDATE executions SET commission = ? WHERE ibkr_exec_id = ? AND commission = 0",
                 (commission, exec_id))


def store_fills(conn: sqlite3.Connection, rows: list[dict]) -> dict:
    """Stage new fills and fill in late commissions. Counts never overlap:
    received = new + updated + unchanged."""
    logged = {r[0] for r in conn.execute(
        "SELECT ibkr_exec_id FROM executions WHERE ibkr_exec_id IS NOT NULL")}
    staged = {r["exec_id"]: dict(r) for r in conn.execute(
        "SELECT exec_id, commission, commission_known FROM ibkr_fills")}
    added = updated = 0
    with conn:
        for r in rows:
            row = {"commission_known": 1, "account": "", **r}
            old = staged.get(row["exec_id"])
            if old is not None and row["account"]:
                # Fills staged before v5 have no account number; a later sync fills it in.
                conn.execute("UPDATE ibkr_fills SET account = ? WHERE exec_id = ? AND account = ''",
                             (row["account"], row["exec_id"]))
            if old is None:
                if row["exec_id"] in logged:
                    continue  # on a trade without a staged copy (older data): leave it alone
                conn.execute(INSERT, tuple(row[c] for c in COLUMNS))
                staged[row["exec_id"]] = {k: row[k] for k in ("commission", "commission_known")}
                added += 1
            elif _fills_in_commission(old, row):
                _apply_commission(conn, row["exec_id"], row["commission"])
                staged[row["exec_id"]] = {"commission": row["commission"], "commission_known": 1}
                updated += 1
    return {"received": len(rows), "new": added, "updated": updated,
            "unchanged": len(rows) - added - updated}


def pending_groups(conn: sqlite3.Connection, status: str = "pending") -> list[dict]:
    """Fills grouped by order (a combo order's legs share one perm id)."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in conn.execute("SELECT * FROM ibkr_fills WHERE status = ? ORDER BY executed_at", (status,)):
        row = dict(r)
        groups[str(row["perm_id"] or row["exec_id"])].append(row)
    return [
        {"key": k, "symbol": fills[0]["symbol"], "executed_at": fills[0]["executed_at"],
         "fills": fills, "net_cash": round(sum(-f["qty"] * f["price"] * f["multiplier"]
                                               - f["commission"] for f in fills), 2)}
        for k, fills in groups.items()
    ]


def _matching_account(conn: sqlite3.Connection, rows: list[dict]) -> int | None:
    """The IBKR account whose broker_ref is the fills' account number, if any. Fills from two
    different account numbers cannot make one trade."""
    numbers = sorted({r["account"] for r in rows if r.get("account")})
    if len(numbers) > 1:
        raise ValueError(f"these fills come from different IBKR accounts ({', '.join(numbers)}); "
                         "assign each account's fills on their own")
    return accounts.ibkr_for_broker_ref(conn, numbers[0]) if numbers else None


def _existing_trade_account(conn: sqlite3.Connection, current: int, matched: int | None) -> int:
    """Real IBKR fills put a trade in an IBKR account: the matching one; else it stays if it is
    in an IBKR account already; else the first IBKR account (if there is one)."""
    if matched is not None:
        return matched
    kind = conn.execute("SELECT type FROM accounts WHERE id = ?", (current,)).fetchone()[0]
    if kind == "ibkr":
        return current
    first = accounts.first_ibkr_id(conn)
    return current if first is None else first


def assign(conn: sqlite3.Connection, data: AssignIn) -> int:
    marks = ",".join("?" * len(data.exec_ids))
    rows = [dict(r) for r in conn.execute(
        f"SELECT * FROM ibkr_fills WHERE exec_id IN ({marks}) AND status = 'pending'", data.exec_ids)]
    if len(rows) != len(set(data.exec_ids)):
        raise ValueError("some fills are not pending any more; reload the queue")
    symbols = {r["symbol"] for r in rows}
    if len(symbols) != 1:
        raise ValueError("fills for different underlyings cannot go in one trade")
    symbol = symbols.pop()
    matched = _matching_account(conn, rows)
    with conn:
        if data.trade_id is None:
            trade_id = repo.insert_trade_header(
                conn, symbol, data.strategy, min(r["executed_at"] for r in rows)[:10], "ibkr",
                matched or accounts.default_id(conn))
            event = "open"
        else:
            trade = repo.load_trades(conn, data.trade_id)[0]
            if trade["underlying"] != symbol:
                raise ValueError(f"trade #{data.trade_id} is {trade['underlying']}, these fills are {symbol}")
            trade_id, event = data.trade_id, data.event or "adjust"
            target = _existing_trade_account(conn, trade["account_id"], matched)
            if target != trade["account_id"]:
                conn.execute("UPDATE trades SET account_id = ? WHERE id = ?", (target, trade_id))
        for r in rows:
            leg = LegIn(kind=r["kind"], strike=r["strike"],
                        expiry=date.fromisoformat(r["expiry"]) if r["expiry"] else None,
                        multiplier=r["multiplier"])
            repo.add_fill_raw(conn, trade_id, leg, event, r["executed_at"], r["qty"], r["price"],
                              r["commission"], ibkr_exec_id=r["exec_id"], con_id=r["con_id"])
        conn.execute(f"UPDATE ibkr_fills SET status = 'assigned' WHERE exec_id IN ({marks})", data.exec_ids)
    return trade_id


def ignore(conn: sqlite3.Connection, data: IgnoreIn) -> int:
    marks = ",".join("?" * len(data.exec_ids))
    new, old = ("pending", "ignored") if data.restore else ("ignored", "pending")
    with conn:
        cur = conn.execute(
            f"UPDATE ibkr_fills SET status = ? WHERE status = ? AND exec_id IN ({marks})",
            [new, old, *data.exec_ids])
    return cur.rowcount
