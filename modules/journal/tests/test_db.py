from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import create_app


def test_backup_skips_missing_db(tmp_path):
    assert db.backup(tmp_path / "none.db", tmp_path / "b") is None


def test_backup_copies_and_prunes(tmp_path, monkeypatch):
    path = tmp_path / "trades.db"
    conn = db.connect(path)
    db.migrate(conn)
    conn.close()
    backups = tmp_path / "b"
    backups.mkdir()
    for i in range(db.BACKUPS_KEPT + 3):
        (backups / f"trades-2000010{i:02d}-000000.db").write_bytes(b"x")
    target = db.backup(path, backups)
    assert target.exists() and target.stat().st_size > 0
    assert len(list(backups.glob("trades-*.db"))) == db.BACKUPS_KEPT
    assert target in backups.glob("trades-*.db")


def _columns(conn, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def test_v1_database_upgrades_to_v2_keeping_its_fills(tmp_path):
    path = tmp_path / "old.db"
    old = db.connect(path)
    db.MIGRATIONS[0](old)  # a database exactly as v1 of the app left it
    old.execute("PRAGMA user_version = 1")
    old.execute(
        "INSERT INTO ibkr_fills (exec_id, executed_at, symbol, sec_type, kind, multiplier, qty, price, "
        "commission) VALUES ('x1', '2026-11-04T10:00:00', 'SPY', 'OPT', 'put', 100, -1, 3.0, 0.65)")
    old.commit()
    old.close()

    conn = db.connect(path)
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert "commission_known" in _columns(conn, "ibkr_fills")
    row = conn.execute("SELECT commission, commission_known FROM ibkr_fills WHERE exec_id = 'x1'").fetchone()
    assert tuple(row) == (0.65, 1)  # what was stored before counts as known
    conn.close()


def test_v2_database_upgrades_to_v3_with_an_empty_analyses_table(tmp_path):
    path = tmp_path / "v2.db"
    old = db.connect(path)
    for step in db.MIGRATIONS[:2]:
        step(old)
    old.execute("PRAGMA user_version = 2")
    old.execute("INSERT INTO trades (underlying, strategy, opened_at) VALUES ('SPY', 'custom', '2026-11-02')")
    old.commit()
    old.close()

    conn = db.connect(path)
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert _columns(conn, "analyses") == {"id", "name", "underlying", "state", "created_at", "updated_at"}
    assert conn.execute("SELECT count(*) FROM analyses").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM trades").fetchone()[0] == 1  # trades untouched
    conn.close()


def test_analyses_table_refuses_bad_rows(tmp_path):
    import sqlite3
    conn = db.connect(tmp_path / "t.db")
    db.migrate(conn)
    row = "INSERT INTO analyses (name, state, created_at, updated_at) VALUES (?, ?, 'a', 'a')"
    for name, state in [("", "{}"), ("x" * 81, "{}"), ("ok", "not json"), ("ok", "[1]")]:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(row, (name, state))
    conn.close()


def test_fresh_and_upgraded_databases_match(tmp_path):
    fresh = db.connect(tmp_path / "fresh.db")
    db.migrate(fresh)
    upgraded = db.connect(tmp_path / "up.db")
    db.MIGRATIONS[0](upgraded)
    upgraded.execute("PRAGMA user_version = 1")
    db.migrate(upgraded)
    tables = [r[0] for r in fresh.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    assert all(_columns(fresh, t) == _columns(upgraded, t) for t in tables)
    fresh.close()
    upgraded.close()


def test_migrate_is_idempotent_and_refuses_newer_schema(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    db.migrate(conn)
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION + 1}")
    with pytest.raises(RuntimeError, match="schema"):
        db.migrate(conn)
    conn.close()


def test_unexpected_error_is_logged_not_leaked(settings, monkeypatch):
    from app.routes import stats as stats_route

    def boom(_views):
        raise KeyError("secret detail")

    monkeypatch.setattr(stats_route, "portfolio", boom)
    with TestClient(create_app(settings), raise_server_exceptions=False) as c:
        resp = c.get("/api/journal/stats")
    assert resp.status_code == 500
    assert resp.json() == {"ok": False, "data": None, "error": "something went wrong; see the server log"}


def test_unknown_route_uses_envelope(client):
    resp = client.get("/api/journal/nope")
    assert resp.status_code == 404 and resp.json()["ok"] is False


# ---------- v5: accounts ----------------------------------------------------------------

def _v4_database(path):
    """A database exactly as v4 of the app left it, with two trades (fills, tags, marks, a
    screenshot), an assigned IBKR fill and a saved portfolio snapshot."""
    conn = db.connect(path)
    for step in db.MIGRATIONS[:4]:
        step(conn)
    conn.execute("PRAGMA user_version = 4")
    for tid, sym in ((1, "SPY"), (2, "QQQ")):
        conn.execute("INSERT INTO trades (id, underlying, strategy, opened_at, thesis, confidence, source) "
                     "VALUES (?, ?, 'custom', '2026-11-02', 'why', 3, 'manual')", (tid, sym))
        conn.execute("INSERT INTO trade_tags VALUES (?, 'tag', 'earnings')", (tid,))
        conn.execute("INSERT INTO legs (id, trade_id, kind, strike, expiry) "
                     "VALUES (?, ?, 'put', 500, '2026-12-18')", (tid, tid))
        conn.execute("INSERT INTO executions (leg_id, executed_at, qty, price, event, ibkr_exec_id) "
                     "VALUES (?, '2026-11-02', -1, 2.5, 'open', ?)", (tid, f"x{tid}"))
        conn.execute("INSERT INTO marks (trade_id, marked_at, position_value) "
                     "VALUES (?, '2026-11-03', -100)", (tid,))
        conn.execute("INSERT INTO screenshots (trade_id, filename) VALUES (?, ?)", (tid, f"s{tid}.png"))
    conn.execute(
        "INSERT INTO ibkr_fills (exec_id, executed_at, symbol, sec_type, kind, multiplier, qty, price, status) "
        "VALUES ('x1', '2026-11-02', 'SPY', 'OPT', 'put', 100, -1, 2.5, 'assigned')")
    conn.execute("INSERT INTO portfolio_snapshot (id, source, saved_at, positions, accounts) "
                 "VALUES (1, 'csv', '2026-11-01T00:00:00+00:00', '[{\"symbol\": \"AAPL\"}]', '[]')")
    conn.commit()
    return conn


def _counts(conn) -> dict:
    tables = ("trades", "trade_tags", "legs", "executions", "marks", "screenshots", "ibkr_fills")
    return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in tables}


def test_v4_database_upgrades_to_v5_with_nothing_lost(tmp_path):
    path = tmp_path / "v4.db"
    old = _v4_database(path)
    before = _counts(old)
    trades_before = [dict(r) for r in old.execute("SELECT * FROM trades ORDER BY id")]
    old.close()

    conn = db.connect(path)
    db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 5
    assert _counts(conn) == before
    accounts = [tuple(r) for r in conn.execute(
        "SELECT name, type, source, broker_ref, sort_order FROM accounts ORDER BY id")]
    assert accounts == [("IBKR", "ibkr", "tws", None, 0), ("Paper", "paper", "journal", None, 1)]
    ibkr = conn.execute("SELECT id FROM accounts WHERE name = 'IBKR'").fetchone()[0]
    after = [dict(r) for r in conn.execute("SELECT * FROM trades ORDER BY id")]
    assert [{k: v for k, v in t.items() if k != "account_id"} for t in after] == trades_before
    assert {t["account_id"] for t in after} == {ibkr}
    snap = conn.execute("SELECT account_id, source, positions FROM portfolio_snapshot").fetchall()
    assert [tuple(r) for r in snap] == [(ibkr, "csv", '[{"symbol": "AAPL"}]')]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.close()


def test_v5_child_tables_still_cascade_from_the_rebuilt_trades_table(tmp_path):
    conn = _v4_database(tmp_path / "v4.db")
    db.migrate(conn)
    conn.execute("DELETE FROM trades WHERE id = 1")
    conn.commit()
    left = _counts(conn)
    assert (left["trades"], left["legs"], left["executions"], left["marks"], left["trade_tags"],
            left["screenshots"]) == (1, 1, 1, 1, 1, 1)
    with pytest.raises(sqlite3.IntegrityError):  # a trade must name a real account
        conn.execute("UPDATE trades SET account_id = 999 WHERE id = 2")
    with pytest.raises(sqlite3.IntegrityError):  # an account in use cannot be deleted
        conn.execute("DELETE FROM accounts WHERE id = (SELECT account_id FROM trades WHERE id = 2)")
    conn.close()


def test_v5_snapshot_goes_with_its_account(tmp_path):
    conn = _v4_database(tmp_path / "v4.db")
    db.migrate(conn)
    conn.execute("DELETE FROM trades")
    conn.execute("DELETE FROM accounts WHERE name = 'IBKR'")
    conn.commit()
    assert conn.execute("SELECT count(*) FROM portfolio_snapshot").fetchone()[0] == 0
    conn.close()


def test_fresh_v5_database_has_the_two_seeded_accounts_and_no_snapshot(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    db.migrate(conn)
    assert [r[0] for r in conn.execute("SELECT name FROM accounts ORDER BY sort_order")] == ["IBKR", "Paper"]
    assert conn.execute("SELECT count(*) FROM portfolio_snapshot").fetchone()[0] == 0
    assert "account" in _columns(conn, "ibkr_fills")
    conn.close()


def _schema(conn) -> list[tuple]:
    return sorted(tuple(r) for r in conn.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))


def test_fresh_and_upgraded_v5_schemas_are_identical(tmp_path):
    fresh = db.connect(tmp_path / "fresh.db")
    db.migrate(fresh)
    upgraded = _v4_database(tmp_path / "up.db")
    db.migrate(upgraded)
    assert _schema(fresh) == _schema(upgraded)
    fresh.close()
    upgraded.close()


@pytest.mark.parametrize("name,type_,source,ref", [
    ("", "paper", "journal", None),                 # empty name
    ("x" * 41, "paper", "journal", None),           # too long
    ("bad\nname", "paper", "journal", None),        # control character
    ("ibkr", "paper", "journal", None),             # same name as IBKR, ignoring case
    ("A", "cash", "journal", None),                 # unknown type
    ("A", "ibkr", "csv", None),                     # ibkr must read TWS
    ("A", "paper", "tws", None),                    # paper is the journal
    ("A", "other", "tws", None),                    # other is csv or journal
    ("A", "other", "csv", ""),                      # empty broker ref
])
def test_accounts_table_refuses_bad_rows(tmp_path, name, type_, source, ref):
    conn = db.connect(tmp_path / "t.db")
    db.migrate(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO accounts (name, type, source, broker_ref, created_at) "
                     "VALUES (?, ?, ?, ?, 'now')", (name, type_, source, ref))
    conn.execute("INSERT INTO accounts (name, type, source, created_at) "
                 "VALUES ('Schwab', 'other', 'journal', 'now')")
    conn.close()


def test_a_failed_v5_step_leaves_the_v4_database_untouched(tmp_path, monkeypatch):
    path = tmp_path / "v4.db"
    _v4_database(path).close()

    def boom(*_args):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(db, "_rebuild_snapshots", boom)
    conn = db.connect(path)
    with pytest.raises(RuntimeError, match="disk on fire"):
        db.migrate(conn)
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.close()
    conn = db.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 4
    assert "account_id" not in _columns(conn, "trades")
    assert conn.execute("SELECT count(*) FROM sqlite_master WHERE name = 'accounts'").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM trades").fetchone()[0] == 2
    conn.close()
