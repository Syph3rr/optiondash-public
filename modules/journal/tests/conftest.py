"""Fixtures: every test gets its own temp database; the real data/ folder is never touched."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import ROOT, load_settings
from app.main import create_app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def no_broker(url: str, _timeout: float):
    """Default broker for tests that should never reach it."""
    pytest.fail(f"broker called: {url}")


@pytest.fixture
def settings(tmp_path: Path):
    return replace(
        load_settings(),
        db_path=tmp_path / "trades.db",
        screenshot_dir=tmp_path / "shots",
        backup_dir=tmp_path / "backups",
        static_dir=ROOT / "static",
        risk_free_rate=0.04,
        max_upload_bytes=1024,
        allowed_hosts=("127.0.0.1", "localhost", "testserver"),  # TestClient's Host header
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings, broker_fetch=no_broker)) as c:
        yield c


def opt(kind: str, strike: float, expiry: str = "2026-12-18") -> dict:
    return {"kind": kind, "strike": strike, "expiry": expiry}


def put_spread(**extra) -> dict:
    """Short 540/535 put spread for 1.20 credit."""
    return {
        "underlying": "spy", "strategy": "bull_put_spread", "opened_at": "2026-11-02",
        "underlying_entry": 550, "iv_entry": 20,
        "fills": [
            {"leg": opt("put", 540), "qty": -1, "price": 3.00, "commission": 0.65},
            {"leg": opt("put", 535), "qty": 1, "price": 1.80, "commission": 0.65},
        ],
        **extra,
    }


def data(resp) -> dict:
    body = resp.json()
    assert body["ok"], body
    return body["data"]
