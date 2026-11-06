"""Creating a trade together with its later closes and adjustments (backfilling)."""
from __future__ import annotations

import pytest

from tests.conftest import data, opt

CALL = opt("call", 100, "2026-12-18")


def long_calls(events: list[dict] | None = None, **extra) -> dict:
    """Bought 10 calls at 2.00 on 1 Oct, plus whatever later events are given."""
    body = {
        "underlying": "abc", "strategy": "long_call", "opened_at": "2026-10-01",
        "fills": [{"leg": CALL, "qty": 10, "price": 2.00, "commission": 1.0}],
        **extra,
    }
    if events is not None:
        body["events"] = events
    return body


def sell(qty: float, price: float, when: str, event: str = "close", commission: float = 0.5) -> dict:
    return {"event": event, "executed_at": when,
            "fills": [{"leg": CALL, "qty": -qty, "price": price, "commission": commission}]}


def post(client, body: dict):
    return client.post("/api/journal/trades", json=body)


def test_two_partial_closes_on_different_dates(client):
    resp = post(client, long_calls([sell(4, 3.00, "2026-10-08"), sell(6, 2.50, "2026-10-15")]))
    assert resp.status_code == 201, resp.json()
    v = resp.json()["data"]
    assert len(v["legs"]) == 1
    leg = v["legs"][0]
    assert leg["net_qty"] == 0
    assert v["status"] == "closed" and v["closed_at"] == "2026-10-15"
    # 4 x 1.00 x 100 + 6 x 0.50 x 100 = 700, less 1.00 + 0.50 + 0.50 commission
    assert v["realized_pnl"] == pytest.approx(698.0)
    execs = leg["executions"]
    assert [e["event"] for e in execs] == ["open", "close", "close"]
    assert [e["executed_at"] for e in execs] == ["2026-10-01", "2026-10-08", "2026-10-15"]
    assert [e["qty"] for e in execs] == [10, -4, -6]


def test_events_are_written_in_date_order(client):
    # Given out of order: the later close first. Stored oldest first, ties keep their order.
    events = [sell(6, 2.50, "2026-10-15"), sell(2, 3.00, "2026-10-08"), sell(2, 3.10, "2026-10-08")]
    v = data(post(client, long_calls(events)))
    execs = v["legs"][0]["executions"]
    assert [(e["executed_at"], e["price"]) for e in execs] == [
        ("2026-10-01", 2.0), ("2026-10-08", 3.0), ("2026-10-08", 3.1), ("2026-10-15", 2.5)]
    ids = [e["id"] for e in execs]
    assert ids == sorted(ids)


def test_partial_close_leaves_trade_open(client):
    v = data(post(client, long_calls([sell(4, 3.00, "2026-10-08", commission=0)])))
    assert v["status"] == "open"
    assert v["legs"][0]["net_qty"] == 6
    assert v["legs"][0]["realized"] == pytest.approx(400.0)


def test_over_close_across_events_writes_nothing(client):
    resp = post(client, long_calls([sell(4, 3.00, "2026-10-08"), sell(7, 2.50, "2026-10-15")]))
    assert resp.status_code == 400
    body = resp.json()
    assert body["ok"] is False and "only 6 open" in body["error"]
    assert data(client.get("/api/journal/trades")) == []


def test_close_on_an_unopened_leg_is_refused(client):
    other = opt("call", 110, "2026-12-18")
    event = {"event": "close", "executed_at": "2026-10-08",
             "fills": [{"leg": other, "qty": -1, "price": 1.0}]}
    resp = post(client, long_calls([event]))
    assert resp.status_code == 400 and "nothing open" in resp.json()["error"]
    assert data(client.get("/api/journal/trades")) == []


def test_adjust_event_may_add_a_leg(client):
    hedge = opt("call", 110, "2026-12-18")
    event = {"event": "adjust", "executed_at": "2026-10-05",
             "fills": [{"leg": hedge, "qty": -10, "price": 0.80}]}
    v = data(post(client, long_calls([event])))
    assert sorted(l["strike"] for l in v["legs"]) == [100, 110]


def test_event_before_opened_is_422(client):
    resp = post(client, long_calls([sell(4, 3.00, "2026-09-30")]))
    assert resp.status_code == 422
    assert "before the trade was opened" in resp.json()["error"]


def test_event_on_opened_day_with_time_is_fine(client):
    v = data(post(client, long_calls([sell(4, 3.00, "2026-10-01T15:30:00")])))
    assert v["legs"][0]["net_qty"] == 6


def test_leg_id_in_create_events_is_422(client):
    event = {"event": "close", "executed_at": "2026-10-08",
             "fills": [{"leg_id": 1, "qty": -4, "price": 3.0}]}
    resp = post(client, long_calls([event]))
    assert resp.status_code == 422
    assert "describe their leg" in resp.json()["error"]


def test_too_many_events_is_422(client):
    events = [sell(0.1, 3.00, "2026-10-08") for _ in range(31)]
    assert post(client, long_calls(events)).status_code == 422


def test_empty_events_still_works(client):
    v = data(post(client, long_calls([])))
    assert v["legs"][0]["net_qty"] == 10 and v["status"] == "open"
