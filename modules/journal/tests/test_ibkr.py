"""IBKR import against a fake broker (the gateway's /api/broker). Nothing here touches TWS."""
from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.ibkr.broker import FETCH_TIMEOUT_S, NOT_CONNECTED, TIMED_OUT
from app.main import create_app
from tests.conftest import data, put_spread

BROKER = "http://broker.test/api/broker"


def row(exec_id, qty=-1, price=3.0, perm=500, commission=0.65, **kw) -> dict:
    """One execution in the broker's JSON shape."""
    base = {
        "exec_id": exec_id, "order_id": perm, "perm_id": perm,
        "executed_at": "2026-11-04T14:30:00", "symbol": "SPY", "sec_type": "OPT",
        "kind": "put", "strike": 540.0, "expiry": "2026-12-18", "multiplier": 100,
        "qty": qty, "price": price, "commission": commission, "commission_known": True,
        "con_id": 1, "account": "U123",
    }
    return {**base, **kw}


SPREAD_ROWS = [
    row("e1", -1, 3.0, strike=540.0, con_id=1),
    row("e2", 1, 1.8, strike=535.0, con_id=2, commission=0.0, commission_known=False),
    row("e3", 1, 1.2, sec_type="BAG", kind="call"),             # combo parent: skipped
    row("e4", 100, 550.0, perm=600, sec_type="STK", kind="stock", strike=None,
        expiry=None, multiplier=1, con_id=3),
]


@pytest.fixture
def env(settings):
    state = SimpleNamespace(rows=[dict(r) for r in SPREAD_ROWS], status=200, body=None,
                            error=None, calls=[])

    async def fetch(url: str, timeout: float):
        state.calls.append((url, timeout))
        if state.error is not None:
            raise state.error
        if state.body is not None or state.status != 200:
            return state.status, state.body if state.body is not None else {"error": "broker says no"}
        return 200, {"executions": state.rows, "as_of": "2026-11-04T15:00:00"}

    app = create_app(replace(settings, broker_url=BROKER + "/"), broker_fetch=fetch)
    with TestClient(app) as c:
        state.client = c
        yield state


def sync(env) -> dict:
    return data(env.client.post("/api/journal/ibkr/sync"))


def sync_error(env, status: int) -> str:
    resp = env.client.post("/api/journal/ibkr/sync")
    assert resp.status_code == status, resp.text
    return resp.json()["error"]


# ---------- the journal never connects to TWS itself ------------------------------------

def test_startup_and_info_never_reach_the_broker(env):
    assert data(env.client.get("/api/journal/ibkr/info")) == {"last_sync": None}
    assert env.calls == []


def test_connect_endpoints_are_gone(env):
    for path in ("connect", "disconnect", "status"):
        resp = env.client.request("POST" if path != "status" else "GET", f"/api/journal/ibkr/{path}")
        assert resp.status_code in (404, 405)
    assert env.calls == []


def test_sync_asks_the_broker_for_executions(env):
    sync(env)
    assert env.calls == [(BROKER + "/executions", FETCH_TIMEOUT_S)]
    assert data(env.client.get("/api/journal/ibkr/info"))["last_sync"] is not None


# ---------- broker failures become clear messages ---------------------------------------

def test_not_connected_is_a_clear_409(env):
    env.status, env.body = 409, {"error": ""}
    assert sync_error(env, 409) == NOT_CONNECTED


def test_not_connected_keeps_the_brokers_wording(env):
    env.status, env.body = 409, {"error": "not connected to TWS; press Connect IBKR"}
    assert "press Connect" in sync_error(env, 409)


def test_gateway_down_is_a_clear_503(env):
    env.error = httpx.ConnectError("refused")
    assert "Broker unavailable" in sync_error(env, 503)


def test_market_service_offline(env):
    env.status = 503
    assert sync_error(env, 503) == "Broker unavailable: broker says no"


def test_broker_timeout_is_504(env):
    env.error = httpx.ReadTimeout("slow")
    assert "did not answer" in sync_error(env, 504)


def test_gateway_timeout_keeps_its_message(env):
    env.status, env.body = 504, {"error": "TWS did not answer the executions request within 15s; try again"}
    assert "within 15s" in sync_error(env, 504)


def test_gateway_timeout_without_message(env):
    env.status, env.body = 504, {"error": ""}
    assert sync_error(env, 504) == TIMED_OUT


def test_other_broker_status(env):
    env.status = 500
    assert sync_error(env, 502).startswith("Broker error (500)")


@pytest.mark.parametrize("body", [[], {"executions": "nope"}, {"other": 1}, "text"])
def test_unexpected_reply(env, body):
    env.body = body
    assert "unexpected reply" in sync_error(env, 502)


def test_invalid_fill_rejects_the_whole_sync(env):
    env.rows = [row("bad", qty=0)]
    assert "invalid fill" in sync_error(env, 502)
    assert data(env.client.get("/api/journal/ibkr/pending")) == []


# ---------- import flow ----------------------------------------------------------------

def test_sync_stores_fills_and_dedupes(env):
    first = sync(env)
    assert first["received"] == 3 and first["new"] == 3  # BAG parent skipped
    groups = data(env.client.get("/api/journal/ibkr/pending"))
    assert [len(g["fills"]) for g in groups] == [2, 1]
    spread = {f["exec_id"]: f for f in groups[0]["fills"]}
    assert spread["e1"]["qty"] == -1 and spread["e1"]["kind"] == "put"
    assert spread["e1"]["expiry"] == "2026-12-18"
    assert spread["e1"]["executed_at"] == "2026-11-04T14:30:00"
    assert spread["e2"]["commission"] == 0.0                     # not reported yet
    assert spread["e2"]["commission_known"] == 0 and spread["e1"]["commission_known"] == 1
    assert groups[0]["net_cash"] == pytest.approx(300 - 180 - 0.65)
    stock = groups[1]["fills"][0]
    assert stock["kind"] == "stock" and stock["multiplier"] == 1 and stock["strike"] is None
    again = sync(env)
    assert again == {**again, "received": 3, "new": 0, "updated": 0, "unchanged": 3}


def test_sync_counts_never_overlap(env):
    env.rows = [row("e1", commission=0.0, commission_known=False), row("e2", perm=501)]
    sync(env)
    env.rows = [row("e1", commission=0.65), row("e2", perm=501), row("e3", perm=502)]
    r = sync(env)
    assert (r["received"], r["new"], r["updated"], r["unchanged"]) == (3, 1, 1, 1)
    assert "already_known" not in r


def test_late_commission_is_backfilled_on_next_sync(env):
    env.rows = [row("e1", commission=0.0, commission_known=False)]
    assert sync(env)["new"] == 1
    env.rows = [row("e1", commission=0.65)]
    again = sync(env)
    assert again["new"] == 0 and again["updated"] == 1
    env.rows = [row("e1", commission=0.0, commission_known=False)]  # a later miss never wipes it
    assert sync(env)["updated"] == 0
    stored = data(env.client.get("/api/journal/ibkr/pending"))[0]["fills"][0]
    assert stored["commission"] == pytest.approx(0.65) and stored["commission_known"] == 1


def test_known_commission_is_never_overwritten(env):
    sync(env)  # e1 known at 0.65
    env.rows = [row("e1", commission=1.30)]
    assert sync(env)["updated"] == 0
    stored = {f["exec_id"]: f for f in data(env.client.get("/api/journal/ibkr/pending"))[0]["fills"]}
    assert stored["e1"]["commission"] == pytest.approx(0.65)


def test_late_commission_reaches_an_already_assigned_fill(env):
    env.rows = [row("e1", -1, 3.0, commission=0.0, commission_known=False)]
    sync(env)
    trade_id = data(env.client.post("/api/journal/ibkr/assign",
                                    json={"exec_ids": ["e1"], "strategy": "short_put"}))["trade_id"]
    commission = lambda: data(env.client.get(f"/api/journal/trades/{trade_id}"))["commissions"]
    assert commission() == 0
    env.rows = [row("e1", -1, 3.0, commission=0.65)]
    assert sync(env)["updated"] == 1
    assert commission() == pytest.approx(0.65)


def test_late_commission_leaves_a_hand_edited_execution_alone(env):
    env.rows = [row("e1", -1, 3.0, commission=0.0, commission_known=False)]
    sync(env)
    trade_id = data(env.client.post("/api/journal/ibkr/assign",
                                    json={"exec_ids": ["e1"], "strategy": "short_put"}))["trade_id"]
    trade = data(env.client.get(f"/api/journal/trades/{trade_id}"))
    exec_id = trade["legs"][0]["executions"][0]["id"]
    env.client.patch(f"/api/journal/executions/{exec_id}", json={"commission": 1.0})
    env.rows = [row("e1", -1, 3.0, commission=0.65)]
    sync(env)
    assert data(env.client.get(f"/api/journal/trades/{trade_id}"))["commissions"] == pytest.approx(1.0)


def test_rebate_is_stored_as_zero_cost(env):
    env.rows = [row("e1", commission=-0.20)]
    sync(env)
    stored = data(env.client.get("/api/journal/ibkr/pending"))[0]["fills"][0]
    assert stored["commission"] == 0 and stored["commission_known"] == 1


def test_assign_to_new_trade(env):
    sync(env)
    body = {"exec_ids": ["e1", "e2"], "strategy": "bull_put_spread"}
    trade_id = data(env.client.post("/api/journal/ibkr/assign", json=body))["trade_id"]
    t = data(env.client.get(f"/api/journal/trades/{trade_id}"))
    assert t["source"] == "ibkr" and t["underlying"] == "SPY" and t["opened_at"] == "2026-11-04"
    assert sorted(l["strike"] for l in t["legs"]) == [535.0, 540.0]
    assert t["initial"]["max_profit"] == pytest.approx(120.0)
    assert [g["key"] for g in data(env.client.get("/api/journal/ibkr/pending"))] == ["600"]
    again = env.client.post("/api/journal/ibkr/assign", json=body)
    assert again.status_code == 400 and "not pending" in again.json()["error"]


def test_assign_to_existing_trade(env):
    sync(env)
    t = data(env.client.post("/api/journal/trades", json=put_spread()))
    body = {"exec_ids": ["e1"], "trade_id": t["id"], "event": "adjust"}
    data(env.client.post("/api/journal/ibkr/assign", json=body))
    v = data(env.client.get(f"/api/journal/trades/{t['id']}"))
    leg540 = next(l for l in v["legs"] if l["strike"] == 540)
    assert leg540["net_qty"] == -2
    assert leg540["executions"][-1]["event"] == "adjust"


def test_assign_rejects_mismatches(env):
    sync(env)
    qqq = data(env.client.post("/api/journal/trades", json=put_spread(underlying="QQQ")))
    resp = env.client.post("/api/journal/ibkr/assign",
                           json={"exec_ids": ["e1"], "trade_id": qqq["id"], "event": "adjust"})
    assert resp.status_code == 400 and "QQQ" in resp.json()["error"]
    env.rows.append(row("e9", symbol="IWM", perm=700))
    sync(env)
    mixed = env.client.post("/api/journal/ibkr/assign",
                            json={"exec_ids": ["e1", "e9"], "strategy": "custom"})
    assert mixed.status_code == 400 and "different underlyings" in mixed.json()["error"]
    both = env.client.post("/api/journal/ibkr/assign",
                           json={"exec_ids": ["e1"], "strategy": "custom", "trade_id": 1})
    assert both.status_code == 422
    missing = env.client.post("/api/journal/ibkr/assign",
                              json={"exec_ids": ["e1"], "trade_id": 999, "event": "adjust"})
    assert missing.status_code == 404


def test_ignore_and_restore(env):
    sync(env)
    assert data(env.client.post("/api/journal/ibkr/ignore", json={"exec_ids": ["e4"]}))["changed"] == 1
    ignored = data(env.client.get("/api/journal/ibkr/pending", params={"status": "ignored"}))
    assert [f["exec_id"] for g in ignored for f in g["fills"]] == ["e4"]
    body = {"exec_ids": ["e4"], "restore": True}
    assert data(env.client.post("/api/journal/ibkr/ignore", json=body))["changed"] == 1
    assert env.client.get("/api/journal/ibkr/pending", params={"status": "bogus"}).status_code == 422


def test_deleting_returns_fills_to_pending(env):
    sync(env)
    trade_id = data(env.client.post(
        "/api/journal/ibkr/assign", json={"exec_ids": ["e1", "e2"], "strategy": "custom"}))["trade_id"]
    t = data(env.client.get(f"/api/journal/trades/{trade_id}"))
    exec_id = t["legs"][0]["executions"][0]["id"]
    data(env.client.delete(f"/api/journal/executions/{exec_id}"))
    pending = data(env.client.get("/api/journal/ibkr/pending"))
    assert any(f["exec_id"] == "e1" for g in pending for f in g["fills"])
    data(env.client.delete(f"/api/journal/trades/{trade_id}"))
    pending = data(env.client.get("/api/journal/ibkr/pending"))
    assert {f["exec_id"] for g in pending for f in g["fills"]} == {"e1", "e2", "e4"}


def test_assign_to_existing_trade_needs_an_event(env):
    sync(env)
    t = data(env.client.post("/api/journal/trades", json=put_spread()))
    resp = env.client.post("/api/journal/ibkr/assign", json={"exec_ids": ["e1"], "trade_id": t["id"]})
    assert resp.status_code == 422 and "event" in resp.json()["error"]


def test_new_trade_from_fills_is_always_open(env):
    sync(env)
    body = {"exec_ids": ["e1"], "strategy": "short_put", "event": "close"}
    assert env.client.post("/api/journal/ibkr/assign", json=body).status_code == 422


def test_assign_close_cannot_add_to_position(env):
    sync(env)
    t = data(env.client.post("/api/journal/trades", json=put_spread()))
    body = {"exec_ids": ["e1"], "trade_id": t["id"], "event": "close"}   # e1 sells the short 540
    resp = env.client.post("/api/journal/ibkr/assign", json=body)
    assert resp.status_code == 400 and "adds to" in resp.json()["error"]
    pending = data(env.client.get("/api/journal/ibkr/pending"))
    assert any(f["exec_id"] == "e1" for g in pending for f in g["fills"])


# ---------- the real HTTP fetcher and config ---------------------------------------------

def test_httpx_get_reads_status_and_json(monkeypatch):
    import asyncio

    from app.ibkr import broker

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/broker/executions"
        if request.url.host == "bad.test":
            return httpx.Response(502, text="not json")
        return httpx.Response(409, json={"error": "not connected"})

    real = httpx.AsyncClient
    monkeypatch.setattr(broker.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    assert asyncio.run(broker.httpx_get("http://ok.test/api/broker/executions", 1)) == (
        409, {"error": "not connected"})
    assert asyncio.run(broker.httpx_get("http://bad.test/api/broker/executions", 1)) == (502, None)


def test_broker_url_must_be_http(monkeypatch):
    from app.config import load_settings
    monkeypatch.setenv("BROKER_URL", "file:///etc/passwd")
    with pytest.raises(ValueError):
        load_settings()
    monkeypatch.setenv("BROKER_URL", "http://127.0.0.1:3000/api/broker/")
    assert load_settings().broker_url == "http://127.0.0.1:3000/api/broker"


# ---------- which account a trade from IBKR fills goes to -------------------------------

ACCOUNTS = "/api/journal/accounts"


def _accounts(env) -> dict:
    return {a["name"]: a["id"] for a in data(env.client.get(ACCOUNTS))}


def _add_account(env, name, broker_ref=None, type_="ibkr") -> int:
    body = {"name": name, "type": type_, **({"broker_ref": broker_ref} if broker_ref else {})}
    return data(env.client.post(ACCOUNTS, json=body))["id"]


def _assign_new(env, exec_ids) -> dict:
    body = {"exec_ids": exec_ids, "strategy": "custom"}
    trade_id = data(env.client.post("/api/journal/ibkr/assign", json=body))["trade_id"]
    return data(env.client.get(f"/api/journal/trades/{trade_id}"))


def test_sync_keeps_each_fills_account_number(env):
    sync(env)
    fills = [f for g in data(env.client.get("/api/journal/ibkr/pending")) for f in g["fills"]]
    assert {f["account"] for f in fills} == {"U123"}


def test_new_trade_goes_to_the_ibkr_account_with_the_fills_account_number(env):
    roth = _add_account(env, "Roth", "u123")  # matched ignoring case
    sync(env)
    assert _assign_new(env, ["e1", "e2"])["account_id"] == roth


def test_new_trade_without_a_matching_account_goes_to_the_first_ibkr_account(env):
    _add_account(env, "Roth", "U999")
    env.rows = [row("e1", account=""), row("e9", perm=900, account="U555")]
    sync(env)
    ibkr = _accounts(env)["IBKR"]
    assert _assign_new(env, ["e1"])["account_id"] == ibkr
    assert _assign_new(env, ["e9"])["account_id"] == ibkr


def test_fills_from_two_ibkr_accounts_cannot_make_one_trade(env):
    env.rows = [row("e1", account="U1"), row("e2", strike=535.0, account="U2")]
    sync(env)
    resp = env.client.post("/api/journal/ibkr/assign", json={"exec_ids": ["e1", "e2"], "strategy": "custom"})
    assert resp.status_code == 400 and "different IBKR accounts" in resp.json()["error"]


def test_assigning_fills_moves_a_non_ibkr_trade_to_the_matching_account(env):
    roth = _add_account(env, "Roth", "U123")
    sync(env)
    paper = _accounts(env)["Paper"]
    t = data(env.client.post("/api/journal/trades", json=put_spread(account_id=paper)))
    body = {"exec_ids": ["e1"], "trade_id": t["id"], "event": "adjust"}
    data(env.client.post("/api/journal/ibkr/assign", json=body))
    assert data(env.client.get(f"/api/journal/trades/{t['id']}"))["account_id"] == roth


def test_assigning_fills_without_an_account_number_keeps_an_ibkr_trade_where_it_is(env):
    roth = _add_account(env, "Roth", "U999")
    env.rows = [row("e1", account="")]
    sync(env)
    t = data(env.client.post("/api/journal/trades", json=put_spread(account_id=roth)))
    body = {"exec_ids": ["e1"], "trade_id": t["id"], "event": "adjust"}
    data(env.client.post("/api/journal/ibkr/assign", json=body))
    assert data(env.client.get(f"/api/journal/trades/{t['id']}"))["account_id"] == roth


def test_a_later_sync_fills_in_a_missing_account_number(env):
    env.rows = [row("e1", account="")]
    sync(env)
    env.rows = [row("e1", account="U123")]
    sync(env)
    fill = data(env.client.get("/api/journal/ibkr/pending"))[0]["fills"][0]
    assert fill["account"] == "U123"
