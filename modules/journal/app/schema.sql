-- Schema version 1. Money is in USD. Prices are per share; cash = qty * price * multiplier.

CREATE TABLE IF NOT EXISTS trades (
    id                    INTEGER PRIMARY KEY,
    underlying            TEXT    NOT NULL,
    strategy              TEXT    NOT NULL,
    opened_at             TEXT    NOT NULL,          -- ISO date of first fill
    underlying_entry      REAL,                      -- spot when opened
    iv_entry              REAL,                      -- percent, e.g. 32.5
    iv_rank_entry         REAL,                      -- 0-100
    max_risk_override     REAL,                      -- $ risk when it cannot be computed
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
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trade_tags (
    trade_id  INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    kind      TEXT    NOT NULL CHECK (kind IN ('tag', 'emotion', 'mistake')),
    value     TEXT    NOT NULL,
    PRIMARY KEY (trade_id, kind, value)
);

CREATE TABLE IF NOT EXISTS legs (
    id           INTEGER PRIMARY KEY,
    trade_id     INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('call', 'put', 'stock')),
    strike       REAL,
    expiry       TEXT,                               -- ISO date, NULL for stock
    multiplier   INTEGER NOT NULL DEFAULT 100,
    ibkr_con_id  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_legs_trade ON legs(trade_id);

CREATE TABLE IF NOT EXISTS executions (
    id            INTEGER PRIMARY KEY,
    leg_id        INTEGER NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
    executed_at   TEXT    NOT NULL,                  -- ISO date or datetime
    qty           REAL    NOT NULL CHECK (qty <> 0), -- + bought, - sold
    price         REAL    NOT NULL CHECK (price >= 0),
    commission    REAL    NOT NULL DEFAULT 0,        -- positive number = cost
    event         TEXT    NOT NULL CHECK (event IN ('open', 'adjust', 'roll', 'close', 'expire', 'assign')),
    ibkr_exec_id  TEXT    UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_exec_leg ON executions(leg_id);

CREATE TABLE IF NOT EXISTS marks (
    id                INTEGER PRIMARY KEY,
    trade_id          INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    marked_at         TEXT    NOT NULL,
    position_value    REAL    NOT NULL,              -- $ to close now; + if long value
    underlying_price  REAL
);

CREATE TABLE IF NOT EXISTS screenshots (
    id         INTEGER PRIMARY KEY,
    trade_id   INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    filename   TEXT    NOT NULL UNIQUE,
    caption    TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Fills pulled from TWS wait here until you assign them to a trade or ignore them.
CREATE TABLE IF NOT EXISTS ibkr_fills (
    exec_id      TEXT    PRIMARY KEY,
    order_id     INTEGER,
    perm_id      INTEGER,
    executed_at  TEXT    NOT NULL,
    symbol       TEXT    NOT NULL,
    sec_type     TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    strike       REAL,
    expiry       TEXT,
    multiplier   INTEGER NOT NULL,
    qty          REAL    NOT NULL,
    price        REAL    NOT NULL,
    commission   REAL    NOT NULL DEFAULT 0,
    con_id       INTEGER,
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'ignored'))
);
