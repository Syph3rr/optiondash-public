"""Saved analyser set-ups: /api/journal/analyses (create, list, get, update, delete)."""
from __future__ import annotations

import pytest

from app.analyses import MAX_STATE_BYTES
from tests.conftest import data

BASE = "/api/journal/analyses"
STATE = {"v": 1, "symbol": "spx", "spot": 5800, "model": "european",
         "legs": [{"kind": "call", "long": True, "qty": 1, "strike": 5800, "dte": 30, "iv": 18}]}


def create(client, name="Iron condor idea", state=None):
    resp = client.post(BASE, json={"name": name, "state": state or STATE})
    assert resp.status_code == 201, resp.text
    return data(resp)


def test_create_returns_the_saved_analysis(client):
    a = create(client)
    assert a["id"] > 0 and a["name"] == "Iron condor idea"
    assert a["underlying"] == "SPX"
    assert a["state"] == STATE
    assert a["created_at"] and a["updated_at"] == a["created_at"]


def test_list_has_no_state_blobs_and_newest_first(client):
    first = create(client, "first")
    second = create(client, "second", {**STATE, "symbol": "QQQ"})
    rows = data(client.get(BASE))
    assert [r["id"] for r in rows] == [second["id"], first["id"]]
    assert set(rows[0]) == {"id", "name", "underlying", "updated_at"}
    assert rows[0]["underlying"] == "QQQ"


def test_list_is_empty_on_a_new_journal(client):
    assert data(client.get(BASE)) == []


def test_get_one(client):
    a = create(client)
    assert data(client.get(f"{BASE}/{a['id']}")) == a


def test_update_name_only_keeps_state(client):
    a = create(client)
    b = data(client.put(f"{BASE}/{a['id']}", json={"name": "  renamed  "}))
    assert b["name"] == "renamed" and b["state"] == STATE
    assert b["updated_at"] >= a["updated_at"]


def test_update_state_only_keeps_name_and_rereads_underlying(client):
    a = create(client)
    b = data(client.put(f"{BASE}/{a['id']}", json={"state": {**STATE, "symbol": "aapl"}}))
    assert b["name"] == a["name"] and b["underlying"] == "AAPL"
    assert b["state"]["symbol"] == "aapl"


def test_update_needs_something_to_change(client):
    a = create(client)
    resp = client.put(f"{BASE}/{a['id']}", json={})
    assert resp.status_code == 422 and "name or state" in resp.json()["error"]


def test_update_cannot_null_the_name(client):
    a = create(client)
    assert client.put(f"{BASE}/{a['id']}", json={"name": None}).status_code == 422


def test_delete_then_404(client):
    a = create(client)
    assert data(client.delete(f"{BASE}/{a['id']}")) == {"deleted": a["id"]}
    resp = client.get(f"{BASE}/{a['id']}")
    assert resp.status_code == 404 and resp.json()["ok"] is False
    assert data(client.get(BASE)) == []


@pytest.mark.parametrize("method", ["get", "delete"])
def test_missing_analysis_is_404(client, method):
    resp = getattr(client, method)(f"{BASE}/999")
    assert resp.status_code == 404
    assert resp.json() == {"ok": False, "data": None, "error": "analysis 999 not found"}


def test_update_missing_analysis_is_404(client):
    assert client.put(f"{BASE}/999", json={"name": "x"}).status_code == 404


@pytest.mark.parametrize("body", [
    {"name": "", "state": STATE},                      # empty
    {"name": "   ", "state": STATE},                   # blank after trimming
    {"name": "x" * 81, "state": STATE},                # too long
    {"name": "bad\nname", "state": STATE},             # control character
    {"name": "ok", "state": [1, 2]},                   # state must be an object
    {"name": "ok", "state": "text"},
    {"name": "ok"},                                    # state missing
    {"state": STATE},                                  # name missing
    {"name": "ok", "state": STATE, "extra": 1},        # unknown field
    {"name": 5, "state": STATE},                       # name must be text
])
def test_create_rejects_bad_input(client, body):
    resp = client.post(BASE, json=body)
    assert resp.status_code == 422, resp.text
    assert resp.json()["ok"] is False
    assert data(client.get(BASE)) == []


def test_name_of_80_characters_is_fine(client):
    assert create(client, "y" * 80)["name"] == "y" * 80


def test_state_size_limit(client):
    big = {"v": 1, "blob": "x" * MAX_STATE_BYTES}
    resp = client.post(BASE, json={"name": "big", "state": big})
    assert resp.status_code == 422 and "too large" in resp.json()["error"]
    a = create(client)
    assert client.put(f"{BASE}/{a['id']}", json={"state": big}).status_code == 422


def test_state_size_limit_counts_utf8_bytes(client):
    # 3-byte characters: under the limit in characters, over it in bytes.
    big = {"v": 1, "blob": "€" * (MAX_STATE_BYTES // 2)}
    resp = client.post(BASE, json={"name": "big", "state": big})
    assert resp.status_code == 422 and "too large" in resp.json()["error"]


def test_non_text_symbol_gives_no_underlying(client):
    assert create(client, state={"v": 1, "symbol": 42})["underlying"] is None
    assert create(client, state={"v": 1, "symbol": "x" * 40})["underlying"] is None


def test_names_need_not_be_unique(client):
    create(client, "same")
    create(client, "same")
    assert len(data(client.get(BASE))) == 2


@pytest.mark.parametrize("method,path,body", [
    ("post", BASE, {"name": "x", "state": STATE}),
    ("put", f"{BASE}/1", {"name": "x"}),
    ("delete", f"{BASE}/1", None),
])
def test_cross_site_writes_are_refused(client, method, path, body):
    a = create(client)
    assert a["id"] == 1
    kwargs = {"headers": {"origin": "https://evil.example"}}
    if body is not None:
        kwargs["json"] = body
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == 403
    assert data(client.get(f"{BASE}/1"))["name"] == a["name"]
    assert len(data(client.get(BASE))) == 1


def test_cross_site_fetch_metadata_refused(client):
    resp = client.post(BASE, json={"name": "x", "state": STATE}, headers={"sec-fetch-site": "cross-site"})
    assert resp.status_code == 403
    assert data(client.get(BASE)) == []


def test_foreign_host_is_refused(client):
    assert client.get(BASE, headers={"host": "evil.example"}).status_code == 400
