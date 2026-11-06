"""SQLite connection, schema creation and backups."""
from __future__ import annotations

import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 5
SCHEMA_FILE = Path(__file__).with_name("schema.sql")  # the v1 schema; later steps alter it
BACKUPS_KEPT = 20


def _to_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))


def _to_v2(conn: sqlite3.Connection) -> None:
    # 0 = TWS had not reported the commission when the fill was synced; a later sync fills it
    # in (on the trade too, if the fill was already assigned). Existing rows count as known.
    conn.execute(
        "ALTER TABLE ibkr_fills ADD COLUMN commission_known INTEGER NOT NULL DEFAULT 1 "
        "CHECK (commission_known IN (0, 1))")


def _to_v3(conn: sqlite3.Connection) -> None:
    # Saved analyser set-ups. `state` is the analyser's own versioned JSON ({"v": 1, ...});
    # the journal only checks it is a JSON object. `underlying` is copied out for the list.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analyses ("
        " id         INTEGER PRIMARY KEY,"
        " name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),"
        " underlying TEXT,"
        " state      TEXT    NOT NULL CHECK (json_valid(state) AND json_type(state) = 'object'),"
        " created_at TEXT    NOT NULL,"
        " updated_at TEXT    NOT NULL)")


def _to_v4(conn: sqlite3.Connection) -> None:
    # The one saved portfolio snapshot (CSV upload or last TWS read) shown when TWS is off.
    # positions/accounts are JSON lists in the /api/broker/positions and /account row shapes.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS portfolio_snapshot ("
        " id        INTEGER PRIMARY KEY CHECK (id = 1),"
        " source    TEXT    NOT NULL CHECK (source IN ('csv', 'tws')),"
        " saved_at  TEXT    NOT NULL,"
        " positions TEXT    NOT NULL CHECK (json_valid(positions) AND json_type(positions) = 'array'),"
        " accounts  TEXT    NOT NULL CHECK (json_valid(accounts) AND json_type(accounts) = 'array'))")


ACCOUNTS_SQL = (
    "CREATE TABLE accounts ("
    " id         INTEGER PRIMARY KEY,"
    " name       TEXT    NOT NULL UNIQUE COLLATE NOCASE"
    "            CHECK (length(name) BETWEEN 1 AND 40 AND trim(name) = name"
    "                   AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),"
    " type       TEXT    NOT NULL CHECK (type IN ('ibkr', 'paper', 'other')),"
    " source     TEXT    NOT NULL CHECK ((type = 'ibkr' AND source = 'tws')"
    "                                    OR (type = 'paper' AND source = 'journal')"
    "                                    OR (type = 'other' AND source IN ('csv', 'journal'))),"
    " broker_ref TEXT    CHECK (broker_ref IS NULL OR length(broker_ref) BETWEEN 1 AND 32),"
    " sort_order INTEGER NOT NULL DEFAULT 0,"
    " created_at TEXT    NOT NULL)"
)

# The v1 trades table plus account_id. Rebuilt rather than ALTERed: SQLite will not add a
# NOT NULL REFERENCES column with a non-null default while foreign keys are on.
TRADES_V5_SQL = """CREATE TABLE trades_v5 (
    id                    INTEGER PRIMARY KEY,
    underlying            TEXT    NOT NULL,
    strategy              TEXT    NOT NULL,
    opened_at             TEXT    NOT NULL,
    underlying_entry      REAL,
    iv_entry              REAL,
    iv_rank_entry         REAL,
    max_risk_override     REAL,
    setup                 TEXT,
    thesis                TEXT,
    planned_exit          TEXT,
    profit_target         TEXT,
    stop_loss             TEXT,
    confidence            INTEGER CHECK (confidence BETWEEN 1 AND 5),
    review_right          TEXT,
    review_wrong          TEXT,
    lessons               TEXT,
    notes                 TEXT,
    source                TEXT    NOT NULL DEFAULT 'manual',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    account_id            INTEGER NOT NULL REFERENCES accounts(id)
)"""

SNAPSHOT_V5_SQL = (
    "CREATE TABLE portfolio_snapshot_v5 ("
    " account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,"
    " source     TEXT    NOT NULL CHECK (source IN ('csv', 'tws')),"
    " saved_at   TEXT    NOT NULL,"
    " positions  TEXT    NOT NULL CHECK (json_valid(positions) AND json_type(positions) = 'array'),"
    " accounts   TEXT    NOT NULL CHECK (json_valid(accounts) AND json_type(accounts) = 'array'))"
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _rebuild_trades(conn: sqlite3.Connection, account_id: int) -> None:
    """Copy trades into a table with account_id (every existing trade goes to `account_id`),
    then swap it in and recreate whatever indexes and triggers the old table had."""
    extras = [r[0] for r in conn.execute(
        "SELECT sql FROM sqlite_master WHERE tbl_name = 'trades' AND type IN ('index', 'trigger') "
        "AND sql IS NOT NULL")]
    cols = ", ".join(r[1] for r in conn.execute("PRAGMA table_info(trades)"))
    conn.execute(TRADES_V5_SQL)
    conn.execute(f"INSERT INTO trades_v5 ({cols}, account_id) SELECT {cols}, ? FROM trades", (account_id,))
    conn.execute("DROP TABLE trades")
    conn.execute("ALTER TABLE trades_v5 RENAME TO trades")
    for sql in extras:
        conn.execute(sql)
    conn.execute("CREATE INDEX idx_trades_account ON trades(account_id)")


def _rebuild_snapshots(conn: sqlite3.Connection, account_id: int) -> None:
    """One snapshot per account instead of the single id = 1 row; the old one goes to IBKR."""
    conn.execute(SNAPSHOT_V5_SQL)
    conn.execute(
        "INSERT INTO portfolio_snapshot_v5 (account_id, source, saved_at, positions, accounts) "
        "SELECT ?, source, saved_at, positions, accounts FROM portfolio_snapshot", (account_id,))
    conn.execute("DROP TABLE portfolio_snapshot")
    conn.execute("ALTER TABLE portfolio_snapshot_v5 RENAME TO portfolio_snapshot")


def _to_v5(conn: sqlite3.Connection) -> None:
    # Accounts: every trade belongs to one; each account keeps its own portfolio snapshot.
    # Runs with foreign keys off (the table swaps would otherwise cascade-delete children)
    # inside one transaction; migrate() commits it with the version bump, then turns them on.
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("BEGIN")
    conn.execute(ACCOUNTS_SQL)
    now = _now()
    ibkr = conn.execute(
        "INSERT INTO accounts (name, type, source, sort_order, created_at) VALUES ('IBKR', 'ibkr', 'tws', 0, ?)",
        (now,)).lastrowid
    conn.execute(
        "INSERT INTO accounts (name, type, source, sort_order, created_at) "
        "VALUES ('Paper', 'paper', 'journal', 1, ?)", (now,))
    _rebuild_trades(conn, ibkr)
    _rebuild_snapshots(conn, ibkr)
    # The IBKR account number a fill came from, so the importer can pick the right account.
    conn.execute("ALTER TABLE ibkr_fills ADD COLUMN account TEXT NOT NULL DEFAULT ''")
    problems = conn.execute("PRAGMA foreign_key_check").fetchall()
    if problems:
        raise RuntimeError(f"v5 migration left {len(problems)} broken foreign key(s); nothing was changed")


# MIGRATIONS[n] takes a database from version n to n + 1. Every database, new or old,
# walks the same steps, so a fresh install and an upgraded one end up identical.
MIGRATIONS = (_to_v1, _to_v2, _to_v3, _to_v4, _to_v5)


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise RuntimeError(f"database is schema v{version}; this app only knows v{SCHEMA_VERSION}")
    for step in range(version, SCHEMA_VERSION):
        try:
            MIGRATIONS[step](conn)
            conn.execute(f"PRAGMA user_version = {step + 1}")
            conn.commit()
        except BaseException:
            conn.rollback()  # a step that fails leaves the database at the version before it
            raise
        finally:
            conn.execute("PRAGMA foreign_keys = ON")  # a step may turn them off; never left off


def backup(db_path: Path, backup_dir: Path) -> Path | None:
    """Copy the database aside before the app starts. Keeps the newest BACKUPS_KEPT."""
    if not db_path.exists() or db_path.stat().st_size == 0:
        return None
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"trades-{stamp}.db"
    src = sqlite3.connect(db_path)
    try:
        dst = sqlite3.connect(target)
        with dst:
            src.backup(dst)
        dst.close()
    finally:
        src.close()
    for old in sorted(backup_dir.glob("trades-*.db"))[:-BACKUPS_KEPT]:
        old.unlink()
    return target
