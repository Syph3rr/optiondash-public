"""IBKR fill import. The TWS connection itself belongs to the platform's broker
(`/api/broker/*` on the gateway); the journal only asks it for executions on Sync."""
from __future__ import annotations

import sqlite3
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request

from ..deps import get_conn, ok
from ..ibkr import importer
from ..ibkr.broker import BrokerClient
from ..ibkr.importer import AssignIn, IgnoreIn

router = APIRouter(prefix="/ibkr")


def get_broker(request: Request) -> BrokerClient:
    return request.app.state.broker


Broker = Depends(get_broker)
Conn = Depends(get_conn)


@router.get("/info")
def info(request: Request) -> dict:
    return ok({"last_sync": request.app.state.last_sync})


@router.post("/sync")
async def sync(request: Request, broker: BrokerClient = Broker,
               conn: sqlite3.Connection = Conn) -> dict:
    rows = await broker.executions()
    counts = importer.store_fills(conn, rows)
    request.app.state.last_sync = datetime.now().isoformat(timespec="seconds")
    return ok({**counts, "last_sync": request.app.state.last_sync})


@router.get("/pending")
def pending(status: str = Query("pending", pattern="^(pending|ignored)$"),
            conn: sqlite3.Connection = Conn) -> dict:
    return ok(importer.pending_groups(conn, status))


@router.post("/assign")
def assign(body: AssignIn, conn: sqlite3.Connection = Conn) -> dict:
    return ok({"trade_id": importer.assign(conn, body)})


@router.post("/ignore")
def ignore(body: IgnoreIn, conn: sqlite3.Connection = Conn) -> dict:
    return ok({"changed": importer.ignore(conn, body)})
