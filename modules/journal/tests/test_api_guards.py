"""Input guards added after review: over-closing, timed events, Infinity, nulls, upload rollback."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import PNG, data, no_broker, opt
from tests.test_api import create, legs_by_strike


def event(client, trade_id, kind, fills, when="2026-11-10"):
    return client.post(f"/api/journal/trades/{trade_id}/events",
                       json={"event": kind, "executed_at": when, "fills": fills})


@pytest.mark.parametrize("kind", ["close", "expire", "assign"])
def test_cannot_close_more_than_is_open(client, kind):
    t = create(client)
    short = legs_by_strike(t)[540]
    resp = event(client, t["id"], kind, [{"leg_id": short["id"], "qty": 3, "price": 1.0}])
    assert resp.status_code == 400 and "only 1 open" in resp.json()["error"]
    assert legs_by_strike(data(client.get(f"/api/journal/trades/{t['id']}")))[540]["net_qty"] == -1


def test_close_cannot_add_to_the_position(client):
    t = create(client)
    short = legs_by_strike(t)[540]
    resp = event(client, t["id"], "close", [{"leg_id": short["id"], "qty": -1, "price": 1.0}])
    assert resp.status_code == 400 and "adds to" in resp.json()["error"]


def test_close_on_a_leg_with_nothing_open(client):
    t = create(client)
    resp = event(client, t["id"], "close", [{"leg": opt("put", 500), "qty": 1, "price": 1.0}])
    assert resp.status_code == 400 and "nothing open" in resp.json()["error"]
    assert len(data(client.get(f"/api/journal/trades/{t['id']}"))["legs"]) == 2  # rolled back


def test_bad_fill_rolls_back_the_whole_event(client):
    t = create(client)
    legs = legs_by_strike(t)
    fills = [{"leg_id": legs[540]["id"], "qty": 1, "price": 1.0},
             {"leg_id": legs[535]["id"], "qty": 5, "price": 0.4}]
    assert event(client, t["id"], "close", fills).status_code == 400
    after = legs_by_strike(data(client.get(f"/api/journal/trades/{t['id']}")))
    assert after[540]["net_qty"] == -1 and after[535]["net_qty"] == 1


def test_adjust_may_flip(client):
    t = create(client)
    short = legs_by_strike(t)[540]
    v = data(event(client, t["id"], "adjust", [{"leg_id": short["id"], "qty": 2, "price": 1.0}]))
    assert legs_by_strike(v)[540]["net_qty"] == 1


def test_event_can_carry_a_time(client):
    t = create(client)
    short = legs_by_strike(t)[540]
    v = data(event(client, t["id"], "close", [{"leg_id": short["id"], "qty": 1, "price": 1.0}],
                   when="2026-11-05T10:15:00"))
    assert legs_by_strike(v)[540]["executions"][-1]["executed_at"] == "2026-11-05T10:15:00"
    plain = data(event(client, t["id"], "close",
                       [{"leg_id": legs_by_strike(t)[535]["id"], "qty": -1, "price": 0.4}]))
    assert legs_by_strike(plain)[535]["executions"][-1]["executed_at"] == "2026-11-10"


def test_infinity_is_rejected(client):
    t = create(client)
    exec_id = t["legs"][0]["executions"][0]["id"]
    headers = {"content-type": "application/json"}
    resp = client.patch(f"/api/journal/executions/{exec_id}", content='{"qty": Infinity}', headers=headers)
    assert resp.status_code == 422
    resp = client.post(f"/api/journal/trades/{t['id']}/marks", headers=headers,
                       content='{"marked_at": "2026-11-05", "position_value": Infinity}')
    assert resp.status_code == 422
    resp = client.patch(f"/api/journal/executions/{exec_id}", json={"qty": 10_000_000})
    assert resp.status_code == 422


@pytest.mark.parametrize("field", ["underlying", "strategy", "opened_at"])
def test_required_fields_cannot_be_nulled(client, field):
    t = create(client)
    resp = client.patch(f"/api/journal/trades/{t['id']}", json={field: None})
    assert resp.status_code == 422 and field in resp.json()["error"]


def test_failed_screenshot_write_leaves_nothing_behind(settings, monkeypatch):
    def boom(self, _data):
        raise OSError("disk full")

    app = create_app(settings, broker_fetch=no_broker)
    with TestClient(app, raise_server_exceptions=False) as client:
        t = create(client)
        monkeypatch.setattr(Path, "write_bytes", boom)
        resp = client.post(f"/api/journal/trades/{t['id']}/screenshots",
                           files={"file": ("a.png", PNG, "image/png")})
        assert resp.status_code == 500 and resp.json()["ok"] is False
        assert data(client.get(f"/api/journal/trades/{t['id']}"))["screenshots"] == []
    assert list(settings.screenshot_dir.glob("*")) == []


def test_screenshot_on_missing_trade_writes_no_file(client, settings):
    resp = client.post("/api/journal/trades/999/screenshots", files={"file": ("a.png", PNG, "image/png")})
    assert resp.status_code == 404
    assert list(settings.screenshot_dir.glob("*")) == []
