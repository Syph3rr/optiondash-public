"""Accounts: /api/journal/accounts, per-account snapshots, the trade account filter and bulk move."""
from __future__ import annotations

import pytest

from app.portfolio import parse_csv
from tests.conftest import data, put_spread
from tests.test_api import close_all

BASE = "/api/journal/accounts"
CSV = "type,symbol,qty,avg_cost,strike,expiry\nstock,AAPL,100,212.4,,\ncall,SPY,-2,4.35,600,2026-12-18\n"


def error(resp, status: int) -> str:
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert body["ok"] is False and body["data"] is None, body
    return body["error"]


def accounts(client) -> list[dict]:
    return data(client.get(BASE))


def by_name(client) -> dict:
    return {a["name"]: a for a in accounts(client)}


def add(client, **body) -> dict:
    resp = client.post(BASE, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


def trade(client, **extra) -> dict:
    return data(client.post("/api/journal/trades", json=put_spread(**extra)))


# ---------------------------------------------------------------- list / create

def test_a_new_journal_has_ibkr_and_paper(client):
    rows = accounts(client)
    assert [(a["name"], a["type"], a["source"], a["sort_order"]) for a in rows] == [
        ("IBKR", "ibkr", "tws", 0), ("Paper", "paper", "journal", 1)]
    first = rows[0]
    assert set(first) == {"id", "name", "type", "source", "broker_ref", "sort_order", "created_at",
                          "trades", "open_trades", "snapshot"}
    assert (first["broker_ref"], first["trades"], first["open_trades"], first["snapshot"]) == (None, 0, 0, None)


def test_create_defaults_the_source_by_type_and_goes_last(client):
    ib2 = add(client, name="IBKR Roth", type="ibkr", broker_ref="U7654321")
    other = add(client, name="Schwab", type="other")
    mirror = add(client, name="Tasty", type="other", source="journal")
    assert (ib2["source"], ib2["broker_ref"]) == ("tws", "U7654321")
    assert (other["source"], mirror["source"]) == ("csv", "journal")
    assert [a["name"] for a in accounts(client)] == ["IBKR", "Paper", "IBKR Roth", "Schwab", "Tasty"]
    assert other["sort_order"] > ib2["sort_order"] > 1
    assert add(client, name="  Spaced  ", type="paper")["name"] == "Spaced"


@pytest.mark.parametrize("body,status,needle", [
    ({"name": "", "type": "paper"}, 422, "name"),
    ({"name": "x" * 41, "type": "paper"}, 422, "name"),
    ({"name": "tab\there", "type": "paper"}, 422, "control"),
    ({"name": "A", "type": "cash"}, 422, "type"),
    ({"name": "A", "type": "ibkr", "source": "csv"}, 400, "source"),
    ({"name": "A", "type": "paper", "source": "csv"}, 400, "source"),
    ({"name": "A", "type": "other", "source": "tws"}, 400, "source"),
    ({"name": "A", "type": "other", "broker_ref": "U1 2"}, 422, "broker_ref"),
    ({"name": "A", "type": "other", "extra": 1}, 422, "extra"),
    ({"name": "paper", "type": "other"}, 409, "already"),
])
def test_create_refuses_bad_accounts(client, body, status, needle):
    assert needle in error(client.post(BASE, json=body), status)
    assert len(accounts(client)) == 2


def test_cross_site_writes_are_refused(client):
    resp = client.post(BASE, json={"name": "Evil", "type": "other"}, headers={"Origin": "https://evil.example"})
    assert resp.status_code == 403
    _, paper = accounts(client)
    resp = client.delete(f"{BASE}/{paper['id']}", headers={"sec-fetch-site": "cross-site"})
    assert resp.status_code == 403
    assert len(accounts(client)) == 2


def test_a_broker_ref_belongs_to_one_account(client):
    add(client, name="IBKR 2", type="ibkr", broker_ref="U1")
    assert "U1" in error(client.post(BASE, json={"name": "IBKR 3", "type": "ibkr", "broker_ref": "u1"}), 409)


# ---------------------------------------------------------------- update

def test_update_changes_only_what_is_sent(client):
    other = add(client, name="Schwab", type="other")
    resp = client.put(f"{BASE}/{other['id']}", json={"source": "journal", "broker_ref": "X-9"})
    updated = data(resp)
    assert (updated["name"], updated["source"], updated["broker_ref"]) == ("Schwab", "journal", "X-9")
    updated = data(client.put(f"{BASE}/{other['id']}", json={"name": "Schwab IRA", "sort_order": -5,
                                                              "broker_ref": None}))
    assert (updated["name"], updated["sort_order"], updated["broker_ref"]) == ("Schwab IRA", -5, None)
    assert accounts(client)[0]["name"] == "Schwab IRA"  # sort_order first


def test_update_refuses_bad_changes(client):
    ibkr, paper = accounts(client)
    assert "source" in error(client.put(f"{BASE}/{paper['id']}", json={"source": "csv"}), 400)
    assert "type" in error(client.put(f"{BASE}/{paper['id']}", json={"type": "other"}), 422)
    assert "already" in error(client.put(f"{BASE}/{paper['id']}", json={"name": "ibkr"}), 409)
    assert "empty" in error(client.put(f"{BASE}/{paper['id']}", json={"name": None}), 422)
    assert "change" in error(client.put(f"{BASE}/{paper['id']}", json={}), 422)
    assert "not found" in error(client.put(f"{BASE}/999", json={"name": "Z"}), 404)
    assert data(client.put(f"{BASE}/{ibkr['id']}", json={"name": "Ibkr"}))["name"] == "Ibkr"  # own name, new case


# ---------------------------------------------------------------- delete

def test_delete_an_empty_account(client):
    other = add(client, name="Schwab", type="other")
    assert data(client.delete(f"{BASE}/{other['id']}")) == {"deleted": other["id"], "moved": 0}
    assert "not found" in error(client.delete(f"{BASE}/{other['id']}"), 404)


def test_delete_an_account_with_trades_needs_move_to(client):
    ibkr, paper = accounts(client)
    t = trade(client, account_id=paper["id"])
    msg = error(client.delete(f"{BASE}/{paper['id']}"), 409)
    assert "1 trade" in msg and "move_to" in msg
    assert "itself" in error(client.delete(f"{BASE}/{paper['id']}?move_to={paper['id']}"), 400)
    assert "999" in error(client.delete(f"{BASE}/{paper['id']}?move_to=999"), 400)
    assert data(client.delete(f"{BASE}/{paper['id']}?move_to={ibkr['id']}")) == {"deleted": paper["id"], "moved": 1}
    assert data(client.get(f"/api/journal/trades/{t['id']}"))["account_id"] == ibkr["id"]


def test_the_last_account_cannot_be_deleted(client):
    ibkr, paper = accounts(client)
    client.delete(f"{BASE}/{paper['id']}")
    assert "last account" in error(client.delete(f"{BASE}/{ibkr['id']}"), 409)


def test_deleting_an_account_drops_its_snapshot(client):
    ib2 = add(client, name="IBKR 2", type="ibkr")
    client.post(f"{BASE}/{ib2['id']}/snapshot/csv", json={"csv": CSV})
    client.delete(f"{BASE}/{ib2['id']}")
    add(client, name="IBKR 3", type="ibkr")
    assert all(a["snapshot"] is None for a in accounts(client))


# ---------------------------------------------------------------- counts

def test_counts_trades_and_open_trades_per_account(client):
    ibkr, paper = accounts(client)
    trade(client)                                  # default: the IBKR account
    closed = trade(client, account_id=paper["id"])
    trade(client, account_id=paper["id"])
    close_all(client, closed, {540: 0.5, 535: 0.1})
    rows = by_name(client)
    assert (rows["IBKR"]["trades"], rows["IBKR"]["open_trades"]) == (1, 1)
    assert (rows["Paper"]["trades"], rows["Paper"]["open_trades"]) == (2, 1)
    views = data(client.get("/api/journal/trades"))
    assert sum(v["status"] == "open" for v in views) == 2


# ---------------------------------------------------------------- snapshots

def test_each_account_keeps_its_own_snapshot(client):
    ibkr = accounts(client)[0]
    other = add(client, name="Schwab", type="other")
    resp = client.post(f"{BASE}/{other['id']}/snapshot/csv",
                       json={"csv": CSV, "cash": {"cash": 100, "net_liquidation": None,
                                                 "available_funds": None, "buying_power": None}})
    snap = data(resp)
    assert snap["source"] == "csv" and [p["symbol"] for p in snap["positions"]] == ["AAPL", "SPY"]
    assert snap["accounts"][0]["cash"] == 100.0
    assert data(client.get(f"{BASE}/{ibkr['id']}/snapshot")) is None
    assert data(client.get(f"{BASE}/{other['id']}/snapshot")) == snap
    summary = by_name(client)["Schwab"]["snapshot"]
    assert summary == {"source": "csv", "saved_at": snap["saved_at"], "positions": 2}
    assert data(client.delete(f"{BASE}/{other['id']}/snapshot")) is None
    assert data(client.get(f"{BASE}/{other['id']}/snapshot")) is None


def test_csv_upload_only_for_csv_or_ibkr_accounts(client):
    ibkr, paper = accounts(client)
    mirror = add(client, name="Tasty", type="other", source="journal")
    assert data(client.post(f"{BASE}/{ibkr['id']}/snapshot/csv", json={"csv": CSV}))["source"] == "csv"
    for acc in (paper, mirror):
        assert "journal" in error(client.post(f"{BASE}/{acc['id']}/snapshot/csv", json={"csv": CSV}), 400)
    assert "strike" in error(client.post(f"{BASE}/{ibkr['id']}/snapshot/csv",
                                         json={"csv": "type,symbol,qty,avg_cost\ncall,SPY,1,1\n"}), 400)
    assert "not found" in error(client.post(f"{BASE}/999/snapshot/csv", json={"csv": CSV}), 404)
    assert "not found" in error(client.get(f"{BASE}/999/snapshot"), 404)


def test_tws_snapshot_only_for_ibkr_accounts(client):
    ibkr, paper = accounts(client)
    rows = parse_csv(CSV)
    snap = data(client.put(f"{BASE}/{ibkr['id']}/snapshot/tws", json={"positions": rows}))
    assert snap["source"] == "tws" and snap["positions"] == rows
    assert "IBKR" in error(client.put(f"{BASE}/{paper['id']}/snapshot/tws", json={"positions": rows}), 400)


def test_old_portfolio_endpoints_act_on_the_first_ibkr_account(client):
    ibkr = accounts(client)[0]
    add(client, name="Another IBKR", type="ibkr")
    client.put(f"{BASE}/{ibkr['id']}", json={"sort_order": 50})  # reordering does not change which
    assert client.post("/api/journal/portfolio/csv", json={"csv": CSV}).status_code == 200
    assert data(client.get(f"{BASE}/{ibkr['id']}/snapshot"))["source"] == "csv"
    assert len(data(client.get("/api/journal/portfolio"))["positions"]) == 2
    client.put("/api/journal/portfolio/tws", json={"positions": []})
    assert data(client.get(f"{BASE}/{ibkr['id']}/snapshot"))["source"] == "tws"
    client.delete("/api/journal/portfolio")
    assert data(client.get(f"{BASE}/{ibkr['id']}/snapshot")) is None


def test_old_portfolio_endpoints_without_an_ibkr_account(client):
    ibkr, paper = accounts(client)
    client.delete(f"{BASE}/{ibkr['id']}")
    assert data(client.get("/api/journal/portfolio")) is None
    assert "IBKR" in error(client.post("/api/journal/portfolio/csv", json={"csv": CSV}), 404)
    assert data(client.delete("/api/journal/portfolio")) is None


# ---------------------------------------------------------------- trades

def test_trades_default_to_the_first_ibkr_account_and_carry_its_name(client):
    ibkr, paper = accounts(client)
    t = trade(client)
    assert (t["account_id"], t["account_name"]) == (ibkr["id"], "IBKR")
    listed = data(client.get("/api/journal/trades"))[0]
    assert (listed["account_id"], listed["account_name"]) == (ibkr["id"], "IBKR")
    p = trade(client, account_id=paper["id"])
    assert (p["account_id"], p["account_name"]) == (paper["id"], "Paper")


def test_without_an_ibkr_account_trades_default_to_the_lowest_id(client):
    ibkr, paper = accounts(client)
    client.delete(f"{BASE}/{ibkr['id']}")
    other = add(client, name="Schwab", type="other")
    assert trade(client)["account_id"] == paper["id"] < other["id"]


def test_trade_account_must_exist(client):
    assert "account 999" in error(client.post("/api/journal/trades", json=put_spread(account_id=999)), 400)
    t = trade(client)
    assert "account 999" in error(client.patch(f"/api/journal/trades/{t['id']}", json={"account_id": 999}), 400)
    assert "empty" in error(client.patch(f"/api/journal/trades/{t['id']}", json={"account_id": None}), 422)


def test_patch_moves_a_trade(client):
    _, paper = accounts(client)
    t = trade(client)
    moved = data(client.patch(f"/api/journal/trades/{t['id']}", json={"account_id": paper["id"]}))
    assert (moved["account_id"], moved["account_name"]) == (paper["id"], "Paper")


def test_trades_filter_by_accounts(client):
    ibkr, paper = accounts(client)
    other = add(client, name="Schwab", type="other")
    a, b, c = trade(client), trade(client, account_id=paper["id"]), trade(client, account_id=other["id"])

    def ids(query: str) -> list[int]:
        return sorted(t["id"] for t in data(client.get(f"/api/journal/trades{query}")))

    assert ids("") == sorted([a["id"], b["id"], c["id"]])
    assert ids(f"?accounts={paper['id']}") == [b["id"]]
    assert ids(f"?accounts={ibkr['id']},{other['id']}") == sorted([a["id"], c["id"]])
    assert ids(f"?accounts= {paper['id']} , 999") == [b["id"]]  # unknown ids just match nothing
    for bad in ("", "x", "1,,2", "1.5", "-1", "0"):
        assert "accounts" in error(client.get(f"/api/journal/trades?accounts={bad}"), 422)


def test_bulk_move(client):
    ibkr, paper = accounts(client)
    a, b, c = trade(client), trade(client), trade(client)
    resp = client.post("/api/journal/trades/move", json={"trade_ids": [a["id"], b["id"], a["id"]],
                                                         "account_id": paper["id"]})
    assert data(resp) == {"moved": 2, "account_id": paper["id"]}
    assert {t["id"]: t["account_id"] for t in data(client.get("/api/journal/trades"))} == {
        a["id"]: paper["id"], b["id"]: paper["id"], c["id"]: ibkr["id"]}


def test_bulk_move_refuses_unknown_ids_and_moves_nothing(client):
    ibkr, paper = accounts(client)
    a = trade(client)
    msg = error(client.post("/api/journal/trades/move",
                            json={"trade_ids": [a["id"], 998, 999], "account_id": paper["id"]}), 400)
    assert "998" in msg and "999" in msg
    assert "account 999" in error(client.post("/api/journal/trades/move",
                                              json={"trade_ids": [a["id"]], "account_id": 999}), 400)
    assert error(client.post("/api/journal/trades/move", json={"trade_ids": [], "account_id": paper["id"]}), 422)
    assert data(client.get(f"/api/journal/trades/{a['id']}"))["account_id"] == ibkr["id"]


# ---------------------------------------------------------------- stats

def test_stats_filter_by_accounts(client):
    ibkr, paper = accounts(client)
    for account in (ibkr["id"], paper["id"], paper["id"]):
        close_all(client, trade(client, account_id=account), {540: 0.5, 535: 0.1})
    trade(client, account_id=ibkr["id"])  # still open
    everything = data(client.get("/api/journal/stats"))["headline"]
    paper_only = data(client.get(f"/api/journal/stats?accounts={paper['id']}"))["headline"]
    ibkr_only = data(client.get(f"/api/journal/stats?accounts={ibkr['id']}"))["headline"]
    assert (everything["trades"], everything["open_trades"]) == (3, 1)
    assert (paper_only["trades"], paper_only["open_trades"]) == (2, 0)
    assert (ibkr_only["trades"], ibkr_only["open_trades"]) == (1, 1)
    assert paper_only["total_pnl"] + ibkr_only["total_pnl"] == pytest.approx(everything["total_pnl"])
    assert "accounts" in error(client.get("/api/journal/stats?accounts=abc"), 422)
