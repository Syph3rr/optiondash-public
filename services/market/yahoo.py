"""Yahoo Finance fallback source. Synchronous and thread-safe; never yields IV."""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from contracts import Underlying, clean, mark

log = logging.getLogger("sidecar.yahoo")

SPOT_TTL = 30.0
CHAIN_TTL = 60.0
EARNINGS_TTL = 6 * 3600.0  # report dates move rarely, and the lookup is slow
EARNINGS_RETRY_TTL = 600.0  # a timing lookup that failed is worth another try soon
NEW_YORK = ZoneInfo("America/New_York")
NOON = 12
REQUIRED_COLUMNS = ("contractSymbol", "strike", "lastPrice", "bid", "ask", "volume", "openInterest")


def _default_factory(symbol: str):
    import yfinance as yf  # imported lazily so tests never need the network

    return yf.Ticker(symbol)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _to_yahoo_date(expiry: str) -> str:
    return f"{expiry[:4]}-{expiry[4:6]}-{expiry[6:8]}"


def _from_yahoo_date(date: str) -> str | None:
    parts = str(date).split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    return "".join(parts)


def _class_order(u: Underlying, trading_class: str) -> list[str]:
    if trading_class in u.classes:
        return list(u.classes[u.classes.index(trading_class):])
    return [trading_class, *u.classes]


def _is_class_symbol(symbol, trading_class: str) -> bool:
    s = str(symbol)
    n = len(trading_class)
    return s.startswith(trading_class) and len(s) > n and s[n].isdigit()


def _as_date(d) -> date | None:
    if isinstance(d, datetime):  # a datetime is a date too, but will not compare with one
        return d.date()
    return d if isinstance(d, date) else None


def _report_dates(calendar) -> list[date]:
    found = calendar.get("Earnings Date") if isinstance(calendar, dict) else None
    return sorted(d for d in (_as_date(x) for x in (found or [])) if d is not None)


def _report_time(ticker, day: date) -> tuple[str | None, bool]:
    """'bmo' or 'amc' from a stamp on the calendar's day, and whether the lookup worked. Yahoo's
    stamps can sit a day off the calendar, and a midnight stamp means no time is known, so both
    give None."""
    try:
        stamps = ticker.get_earnings_dates(limit=12).index
    except Exception as exc:  # scraped and fragile; the date alone is still useful
        log.warning("yahoo earnings times failed: %s", exc)
        return None, False
    for stamp in stamps:
        local = stamp.tz_convert(NEW_YORK) if stamp.tzinfo else stamp.tz_localize(NEW_YORK)
        if local.date() == day and (local.hour, local.minute) != (0, 0):
            return ("bmo" if local.hour < NOON else "amc"), True
    return None, True


def _next_report(ticker, today: date) -> tuple[dict, bool]:
    """The report, and whether it is complete enough to keep for the full cache time."""
    upcoming = [d for d in _report_dates(ticker.calendar) if d >= today]
    if not upcoming:
        return {"date": None, "when": None, "source": "yahoo"}, True
    day = upcoming[0]
    when, complete = _report_time(ticker, day)
    return {"date": day.isoformat(), "when": when, "source": "yahoo"}, complete


class YahooSource:
    def __init__(
        self,
        ticker_factory: Callable | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], datetime] | None = None,
    ):
        self._factory = ticker_factory or _default_factory
        self._clock = clock
        self._wall = wall or (lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()
        self._cache: dict[tuple, tuple[float, object]] = {}

    # -- cache -------------------------------------------------------------
    def _fresh(self, key: tuple, ttl: float):
        with self._lock:
            hit = self._cache.get(key)
        if hit is not None and self._clock() - hit[0] < ttl:
            return hit[1]
        return None

    def _stale(self, key: tuple):
        with self._lock:
            hit = self._cache.get(key)
        return None if hit is None else hit[1]

    def _store(self, key: tuple, value) -> None:
        with self._lock:
            self._cache[key] = (self._clock(), value)

    def _cached(self, key: tuple, ttl: float, fetch, empty):
        fresh = self._fresh(key, ttl)
        if fresh is not None:
            return fresh
        try:
            value = fetch()
        except Exception as exc:  # rate limit, network, parse: serve last value
            log.warning("yahoo %s failed: %s", key[0], exc)
            stale = self._stale(key)
            return empty if stale is None else stale
        self._store(key, value)
        return value

    # -- public ------------------------------------------------------------
    def spot(self, u: Underlying) -> dict | None:
        def fetch():
            price = clean(self._factory(u.yahoo).fast_info["lastPrice"])
            if price is None:
                return None
            return {"price": price, "source": "yahoo", "data_type": "yahoo",
                    "as_of": _iso(self._wall())}

        key = ("spot", u.yahoo)
        fresh = self._fresh(key, SPOT_TTL)
        if fresh is not None:
            return fresh
        try:
            value = fetch()
        except Exception as exc:
            log.warning("yahoo spot failed: %s", exc)
            return self._stale(key)
        if value is not None:
            self._store(key, value)
            return value
        return self._stale(key)

    def expiries(self, u: Underlying) -> list[dict]:
        def fetch():
            out = []
            for date in self._factory(u.yahoo).options:
                expiry = _from_yahoo_date(date)
                if expiry is not None:
                    out.append({"expiry": expiry, "trading_class": u.classes[0]})
            return out

        return self._cached(("expiries", u.yahoo), CHAIN_TTL, fetch, [])

    def earnings(self, u: Underlying) -> dict:
        """The next report on or after today in New York. Only stocks report; a failure or
        a fund with no fundamentals gives no date, never an error."""
        none = {"date": None, "when": None, "source": "yahoo"}
        if u.sec_type != "STK":
            return none

        key = ("earnings", u.yahoo)
        with self._lock:
            hit = self._cache.get(key)
        if hit is not None:
            stored_at, (found, complete) = hit
            if self._clock() - stored_at < (EARNINGS_TTL if complete else EARNINGS_RETRY_TTL):
                return found
        try:
            today = self._wall().astimezone(NEW_YORK).date()
            found, complete = _next_report(self._factory(u.yahoo), today)
        except Exception as exc:  # rate limit, network, a fund with no fundamentals
            log.warning("yahoo earnings failed: %s", exc)
            return none if hit is None else hit[1][0]
        self._store(key, (found, complete))
        return found

    def chain(self, u: Underlying, expiry: str, trading_class: str) -> dict[tuple[float, str], dict]:
        def fetch():
            oc = self._factory(u.yahoo).option_chain(_to_yahoo_date(expiry))
            as_of = _iso(self._wall())
            for cls in _class_order(u, trading_class):
                rows = self._rows(oc, cls, as_of)
                if rows:
                    return rows
            return {}

        return self._cached(("chain", u.yahoo, expiry, trading_class), CHAIN_TTL, fetch, {})

    @staticmethod
    def _rows(oc, cls: str, as_of: str) -> dict[tuple[float, str], dict]:
        out: dict[tuple[float, str], dict] = {}
        for right, frame in (("C", oc.calls), ("P", oc.puts)):
            if frame is None or any(c not in frame.columns for c in REQUIRED_COLUMNS):
                continue
            for rec in frame.to_dict("records"):
                strike = clean(rec["strike"])
                if strike is None or not _is_class_symbol(rec["contractSymbol"], cls):
                    continue
                m, kind = mark(rec["bid"], rec["ask"], rec["lastPrice"])
                out[(strike, right)] = {
                    "bid": clean(rec["bid"]), "ask": clean(rec["ask"]),
                    "last": clean(rec["lastPrice"]), "mark": m, "mark_kind": kind,
                    "volume": clean(rec["volume"]),
                    "open_interest": clean(rec["openInterest"]), "as_of": as_of,
                }
        return out
