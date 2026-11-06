"""Contract rules and value cleaning for the market data sidecar."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo("America/New_York")
AM_CLASSES = frozenset({"SPX", "NDX", "RUT"})
AM_SETTLEMENT_MINUTES = 570  # 09:30
PM_SETTLEMENT_MINUTES = 960  # 16:00
STANDARD_MULTIPLIER = "100"
CHAIN_EXCHANGE = "SMART"
DATA_TYPES = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed_frozen"}


@dataclass(frozen=True)
class Underlying:
    symbol: str
    sec_type: str  # 'IND' | 'STK'
    exchange: str
    classes: tuple[str, ...]
    yahoo: str
    suggested_model: str


_INDICES = {
    "SPX": ("CBOE", ("SPXW", "SPX")),
    "NDX": ("NASDAQ", ("NDXP", "NDX")),
    "RUT": ("RUSSELL", ("RUTW", "RUT")),
    "XSP": ("CBOE", ("XSP",)),
}


def resolve(symbol: str) -> Underlying:
    if symbol in _INDICES:
        exchange, classes = _INDICES[symbol]
        return Underlying(symbol, "IND", exchange, classes, "^" + symbol, "european")
    return Underlying(symbol, "STK", "SMART", (symbol,), symbol, "american")


def settlement_minutes(trading_class: str) -> int:
    return AM_SETTLEMENT_MINUTES if trading_class in AM_CLASSES else PM_SETTLEMENT_MINUTES


def dte_days(expiry: str, trading_class: str, now: datetime) -> float:
    """Days from `now` (tz-aware) to settlement of `expiry` (YYYYMMDD) in New York."""
    minutes = settlement_minutes(trading_class)
    settle = datetime(
        int(expiry[:4]), int(expiry[4:6]), int(expiry[6:8]),
        minutes // 60, minutes % 60, tzinfo=NEW_YORK,
    )
    return (settle - now).total_seconds() / 86400


def clean(x) -> float | None:
    """Positive finite number as float, otherwise None."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v > 0 else None


def mark(bid, ask, last) -> tuple[float | None, str | None]:
    b, a, l = clean(bid), clean(ask), clean(last)
    if b is not None and a is not None and b <= a:
        return round((b + a) / 2, 6), "mid"
    if l is not None:
        return l, "last"
    return None, None


def merge_expiries(u: Underlying, chains: Iterable) -> list[dict]:
    """One entry per expiry, using the highest-priority class of `u.classes`."""
    rank = {c: i for i, c in enumerate(u.classes)}
    best: dict[str, str] = {}
    for ch in chains:
        if ch.exchange != CHAIN_EXCHANGE:
            continue
        if str(ch.multiplier) != STANDARD_MULTIPLIER or ch.tradingClass not in rank:
            continue
        for expiry in ch.expirations:
            cur = best.get(expiry)
            if cur is None or rank[ch.tradingClass] < rank[cur]:
                best[expiry] = ch.tradingClass
    return [{"expiry": e, "trading_class": best[e]} for e in sorted(best)]


def nearest_strikes(strikes, spot, n=25) -> list[float]:
    nearest = sorted(strikes, key=lambda k: (abs(k - spot), k))[:n]
    return sorted(float(k) for k in nearest)
