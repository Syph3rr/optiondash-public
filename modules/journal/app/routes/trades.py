"""Trade, execution and mark endpoints."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import accounts, repo
from ..accounts import TradeMove
from ..config import Settings
from ..deps import get_conn, get_settings, ok
from ..models import STRATEGIES, EventIn, ExecutionUpdate, MarkIn, TradeCreate, TradeUpdate
from ..views import build_view
from .files import remove_files

router = APIRouter()

Conn = Depends(get_conn)
Cfg = Depends(get_settings)


def _view(conn: sqlite3.Connection, settings: Settings, trade_id: int) -> dict:
    return build_view(repo.load_trades(conn, trade_id)[0], settings.risk_free_rate)


@router.get("/meta")
def meta(conn: sqlite3.Connection = Conn) -> dict:
    return ok({"strategies": STRATEGIES, "tags": repo.tag_vocabulary(conn)})


@router.get("/trades")
def list_trades(conn: sqlite3.Connection = Conn, settings: Settings = Cfg,
                account_ids: list[int] | None = Depends(accounts.account_filter)) -> dict:
    """?accounts=1,2 keeps only trades in those accounts; left out, every account."""
    views = [build_view(t, settings.risk_free_rate) for t in repo.load_trades(conn, accounts=account_ids)]
    return ok([{k: v for k, v in view.items() if k != "timeline"} for view in views])


@router.post("/trades", status_code=201)
def create_trade(body: TradeCreate, conn: sqlite3.Connection = Conn, settings: Settings = Cfg) -> dict:
    trade_id = repo.create_trade(conn, body, accounts.resolve(conn, body.account_id))
    return ok(_view(conn, settings, trade_id))


@router.post("/trades/move")
def move_trades(body: TradeMove, conn: sqlite3.Connection = Conn) -> dict:
    """Moves trades to another account, all or none: {trade_ids, account_id} -> {moved, account_id}."""
    return ok(accounts.move_trades(conn, body))


@router.get("/trades/{trade_id}")
def get_trade(trade_id: int, conn: sqlite3.Connection = Conn, settings: Settings = Cfg) -> dict:
    return ok(_view(conn, settings, trade_id))


@router.patch("/trades/{trade_id}")
def update_trade(trade_id: int, body: TradeUpdate, conn: sqlite3.Connection = Conn,
                 settings: Settings = Cfg) -> dict:
    if body.account_id is not None:
        accounts.require(conn, body.account_id)
    repo.update_trade(conn, trade_id, body)
    return ok(_view(conn, settings, trade_id))


@router.delete("/trades/{trade_id}")
def delete_trade(trade_id: int, conn: sqlite3.Connection = Conn, settings: Settings = Cfg) -> dict:
    remove_files(settings, repo.delete_trade(conn, trade_id))
    return ok({"deleted": trade_id})


@router.post("/trades/{trade_id}/events")
def add_event(trade_id: int, body: EventIn, conn: sqlite3.Connection = Conn,
              settings: Settings = Cfg) -> dict:
    repo.add_event(conn, trade_id, body)
    return ok(_view(conn, settings, trade_id))


@router.patch("/executions/{exec_id}")
def update_execution(exec_id: int, body: ExecutionUpdate, conn: sqlite3.Connection = Conn) -> dict:
    repo.update_execution(conn, exec_id, body)
    return ok({"updated": exec_id})


@router.delete("/executions/{exec_id}")
def delete_execution(exec_id: int, conn: sqlite3.Connection = Conn) -> dict:
    repo.delete_execution(conn, exec_id)
    return ok({"deleted": exec_id})


@router.post("/trades/{trade_id}/marks", status_code=201)
def add_mark(trade_id: int, body: MarkIn, conn: sqlite3.Connection = Conn,
             settings: Settings = Cfg) -> dict:
    repo.add_mark(conn, trade_id, body)
    return ok(_view(conn, settings, trade_id))


@router.delete("/marks/{mark_id}")
def delete_mark(mark_id: int, conn: sqlite3.Connection = Conn) -> dict:
    repo.delete_mark(conn, mark_id)
    return ok({"deleted": mark_id})
