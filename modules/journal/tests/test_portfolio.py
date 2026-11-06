"""Saved portfolio snapshot: /api/journal/portfolio (CSV upload, TWS auto-save, read, clear)."""
from __future__ import annotations

from app import db
from app.portfolio import MAX_ROWS, parse_csv
from tests.conftest import data

BASE = "/api/journal/portfolio"
HEADER = "type,symbol,qty,avg_cost,strike,expiry,multiplier,trading_class,account"
GOOD = "\n".join([
    HEADER,
    "stock,aapl,100,212.40,,,,,",
    "call,SPY,-2,4.35,600,2026-12-18,,,",
    "put,spx,1,12.5,5800,20261218,,SPXW,U123",
])


def upload(client, csv=GOOD, cash=None):
    body = {"csv": csv} if cash is None else {"csv": csv, "cash": cash}
    return client.post(f"{BASE}/csv", json=body)


def error(resp) -> str:
    body = resp.json()
    assert not body["ok"], body
    return body["error"]


# ---------------------------------------------------------------- CSV parsing

def test_parse_tells_stock_and_options_apart_by_type():
    stock, call, put = parse_csv(GOOD)
    assert stock == {"account": "", "symbol": "AAPL", "sec_type": "STK", "kind": "stock", "strike": None,
                     "expiry": None, "multiplier": 1, "con_id": None, "trading_class": None,
                     "qty": 100.0, "avg_cost": 212.4}
    assert (call["sec_type"], call["kind"], call["strike"], call["expiry"]) == ("OPT", "call", 600.0, "2026-12-18")
    assert (call["multiplier"], call["trading_class"], call["qty"]) == (100, "SPY", -2.0)
    assert (put["kind"], put["expiry"], put["trading_class"], put["account"]) == ("put", "2026-12-18", "SPXW", "U123")


def test_parse_accepts_friendly_spellings_and_any_column_order():
    rows = parse_csv("Symbol,Type,Quantity,Avg Cost,Expiry,Strike\nmsft,Shares,10,$1,234.50,,\nqqq,P,1,2,2026-12-18,500\n"
                     .replace("$1,234.50", '"$1,234.50"'))
    assert rows[0]["kind"] == "stock" and rows[0]["avg_cost"] == 1234.5
    assert rows[1]["kind"] == "put"


def test_parse_skips_blank_lines_and_a_byte_order_mark():
    rows = parse_csv("﻿" + HEADER + "\n\nstock,AAPL,1,1,,,,,\n,,,,,,,,\n")
    assert len(rows) == 1


def test_option_needs_strike_and_expiry_and_stock_must_not_have_them():
    msg = str(_raises("type,symbol,qty,avg_cost,strike,expiry\ncall,SPY,1,1,,\nstock,AAPL,1,1,100,2026-12-18\n"))
    assert "row 2 (SPY): strike is needed for a call" in msg
    assert "row 2 (SPY): expiry is needed for a call" in msg
    assert "row 3 (AAPL): leave strike blank for a stock" in msg
    assert "row 3 (AAPL): leave expiry blank for a stock" in msg


def test_bad_values_name_the_row_and_column():
    msg = str(_raises("type,symbol,qty,avg_cost,strike,expiry\n"
                      "opt,SPY,1,1,600,2026-12-18\n"
                      "call,SPY,0,1,600,2026-12-18\n"
                      "call,SPY,1,abc,600,2026-12-18\n"
                      "call,SPY,1,1,600,18/12/2026\n"
                      "call,,1,1,600,2026-12-18\n"))
    assert "row 2 (SPY): type must be stock, call or put (got 'opt')" in msg
    assert "row 3 (SPY): qty cannot be 0" in msg
    assert "row 4 (SPY): avg_cost must be a number (got 'abc')" in msg
    assert "row 5 (SPY): expiry must be YYYY-MM-DD (got '18/12/2026')" in msg
    assert "row 6: symbol is needed" in msg


def test_missing_and_unknown_columns_are_refused():
    assert "missing column(s): avg_cost, qty" in str(_raises("type,symbol\nstock,AAPL\n"))
    assert "unknown column(s): colour" in str(_raises(HEADER + ",colour\nstock,AAPL,1,1,,,,,,red\n"))


def test_the_same_contract_twice_is_refused():
    msg = str(_raises(HEADER + "\nstock,AAPL,1,1,,,,,\nstock,aapl,2,1,,,,,\n"))
    assert "row 3 (AAPL): same position as row 2; combine them into one row" in msg


def test_empty_and_oversized_files_are_refused():
    assert "no positions" in str(_raises(HEADER + "\n"))
    assert "no positions" in str(_raises(""))
    big = HEADER + "\n" + "\n".join(f"stock,S{i},1,1,,,,," for i in range(MAX_ROWS + 1))
    assert f"at most {MAX_ROWS}" in str(_raises(big))


def _raises(csv: str) -> ValueError:
    try:
        parse_csv(csv)
    except ValueError as exc:
        return exc
    raise AssertionError("parse_csv accepted bad input")


# ---------------------------------------------------------------- API

def test_new_journal_has_no_snapshot(client):
    assert data(client.get(BASE)) is None


def test_upload_saves_positions_and_cash_and_reads_back(client):
    resp = upload(client, cash={"cash": 25000.5, "net_liquidation": 61000, "available_funds": None,
                                "buying_power": None})
    assert resp.status_code == 200, resp.text
    snap = data(client.get(BASE))
    assert snap["source"] == "csv" and snap["saved_at"]
    assert [p["symbol"] for p in snap["positions"]] == ["AAPL", "SPY", "SPX"]
    assert snap["accounts"] == [{"account": "", "currency": "USD", "cash": 25000.5, "net_liquidation": 61000.0,
                                 "available_funds": None, "buying_power": None}]


def test_upload_without_cash_figures_saves_no_account_row(client):
    upload(client, cash={"cash": None, "net_liquidation": None, "available_funds": None, "buying_power": None})
    assert data(client.get(BASE))["accounts"] == []


def test_bad_upload_is_refused_and_keeps_the_old_snapshot(client):
    upload(client)
    resp = upload(client, csv=HEADER + "\ncall,SPY,1,1,,,,,\n")
    assert resp.status_code == 400 and "strike is needed" in error(resp)
    assert len(data(client.get(BASE))["positions"]) == 3


def test_tws_save_replaces_positions_and_keeps_cash_when_none_sent(client):
    upload(client, cash={"cash": 100, "net_liquidation": None, "available_funds": None, "buying_power": None})
    tws = parse_csv(GOOD)[:1]
    resp = client.put(f"{BASE}/tws", json={"positions": tws})
    assert resp.status_code == 200, resp.text
    snap = data(client.get(BASE))
    assert snap["source"] == "tws" and snap["positions"] == tws
    assert snap["accounts"][0]["cash"] == 100.0


def test_tws_save_with_accounts_replaces_them(client):
    upload(client, cash={"cash": 100, "net_liquidation": None, "available_funds": None, "buying_power": None})
    accounts = [{"account": "U1", "currency": "USD", "cash": 5.0, "net_liquidation": 9.0,
                 "available_funds": None, "buying_power": None}]
    client.put(f"{BASE}/tws", json={"positions": [], "accounts": accounts})
    snap = data(client.get(BASE))
    assert snap["positions"] == [] and snap["accounts"] == accounts


def test_tws_save_refuses_an_inconsistent_row(client):
    bad = {**parse_csv(GOOD)[1], "strike": None}
    resp = client.put(f"{BASE}/tws", json={"positions": [bad]})
    assert resp.status_code == 422 and "strike" in error(resp)


def test_clear_removes_the_snapshot(client):
    upload(client)
    assert client.delete(BASE).status_code == 200
    assert data(client.get(BASE)) is None


def test_v3_database_upgrades_with_an_empty_snapshot_table(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    for step in range(3):
        db.MIGRATIONS[step](conn)
    conn.execute("PRAGMA user_version = 3")
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert conn.execute("SELECT count(*) FROM portfolio_snapshot").fetchone()[0] == 0
