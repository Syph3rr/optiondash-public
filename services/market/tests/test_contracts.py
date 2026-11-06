from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from contracts import (
    DATA_TYPES,
    clean,
    dte_days,
    mark,
    merge_expiries,
    nearest_strikes,
    resolve,
    settlement_minutes,
)

UTC = timezone.utc


def chain(trading_class, expirations, multiplier=100, exchange="SMART", strikes=(100.0,)):
    return SimpleNamespace(
        exchange=exchange,
        underlyingConId=416904,
        tradingClass=trading_class,
        multiplier=str(multiplier),
        expirations=set(expirations),
        strikes=set(strikes),
    )


def test_resolve_index_prefers_pm_class():
    u = resolve("SPX")
    assert (u.sec_type, u.classes, u.yahoo, u.suggested_model) == ("IND", ("SPXW", "SPX"), "^SPX", "european")


def test_resolve_stock():
    u = resolve("AAPL")
    assert (u.sec_type, u.exchange, u.classes, u.yahoo, u.suggested_model) == ("STK", "SMART", ("AAPL",), "AAPL", "american")


def test_resolve_other_indices():
    assert resolve("NDX").classes == ("NDXP", "NDX")
    assert resolve("RUT").classes == ("RUTW", "RUT")
    assert resolve("XSP").classes == ("XSP",)
    assert resolve("SPX").exchange == "CBOE"


def test_settlement_minutes():
    assert settlement_minutes("SPX") == 570
    assert settlement_minutes("NDX") == 570
    assert settlement_minutes("RUT") == 570
    assert settlement_minutes("SPXW") == 960
    assert settlement_minutes("AAPL") == 960


def test_dte_pm_class_settles_at_1600_new_york():
    now = datetime(2026, 11, 2, 21, 0, tzinfo=UTC)
    assert dte_days("20261103", "SPXW", now) == pytest.approx(1.0)


def test_dte_am_class_settles_at_0930_new_york():
    now = datetime(2026, 11, 20, 14, 30, tzinfo=UTC)
    assert dte_days("20261120", "SPX", now) == pytest.approx(0.0)


def test_dte_across_dst_change():
    now = datetime(2026, 10, 31, 20, 0, tzinfo=UTC)
    assert dte_days("20261101", "SPY", now) == pytest.approx(25 / 24)


@pytest.mark.parametrize("raw,want", [(float("nan"), None), (-1, None), (0, None), (None, None), (98.2, 98.2),
                                      (float("inf"), None), ("x", None)])
def test_clean(raw, want):
    assert clean(raw) == want


@pytest.mark.parametrize("bid,ask,last,want", [
    (98.2, 99.9, 99.2, (99.05, "mid")),
    (None, 99.9, 99.2, (99.2, "last")),
    (101.0, 99.0, 99.2, (99.2, "last")),
    (None, None, None, (None, None)),
    (float("nan"), 0, -1, (None, None)),
])
def test_mark(bid, ask, last, want):
    assert mark(bid, ask, last) == want


def test_merge_prefers_pm_class_and_drops_adjusted():
    chains = [chain("SPX", ["20261120"]), chain("SPXW", ["20261120", "20261112"]), chain("2SPX", ["20261112"])]
    assert merge_expiries(resolve("SPX"), chains) == [
        {"expiry": "20261112", "trading_class": "SPXW"}, {"expiry": "20261120", "trading_class": "SPXW"}]


def test_merge_drops_non_100_multiplier():
    chains = [chain("SPXW", ["20261112"], multiplier=10), chain("SPXW", ["20261120"], multiplier=100)]
    assert merge_expiries(resolve("SPX"), chains) == [{"expiry": "20261120", "trading_class": "SPXW"}]


def test_merge_ignores_non_smart_chain():
    chains = [chain("SPXW", ["20261112"], exchange="CBOE"), chain("SPXW", ["20261120"])]
    assert merge_expiries(resolve("SPX"), chains) == [{"expiry": "20261120", "trading_class": "SPXW"}]


def test_merge_stock_single_class():
    chains = [chain("AAPL", ["20261120", "20261113"]), chain("AAPL1", ["20261113"])]
    assert merge_expiries(resolve("AAPL"), chains) == [
        {"expiry": "20261113", "trading_class": "AAPL"}, {"expiry": "20261120", "trading_class": "AAPL"}]


def test_nearest_strikes_are_sorted_and_limited():
    assert nearest_strikes([90, 95, 100, 105, 110], 101, n=3) == [95, 100, 105]


def test_nearest_strikes_fewer_than_n():
    assert nearest_strikes([110, 100], 101, n=25) == [100, 110]


def test_data_types():
    assert DATA_TYPES == {1: "live", 2: "frozen", 3: "delayed", 4: "delayed_frozen"}
