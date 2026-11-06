"""Portfolio analytics endpoint."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import repo
from ..accounts import account_filter
from ..config import Settings
from ..deps import get_conn, get_settings, ok
from ..stats import portfolio
from ..views import build_view

router = APIRouter()


@router.get("/stats")
def get_stats(conn: sqlite3.Connection = Depends(get_conn),
              settings: Settings = Depends(get_settings),
              account_ids: list[int] | None = Depends(account_filter)) -> dict:
    """?accounts=1,2 counts only trades in those accounts; left out, every account."""
    views = [build_view(t, settings.risk_free_rate) for t in repo.load_trades(conn, accounts=account_ids)]
    return ok(portfolio(views))
