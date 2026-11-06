from datetime import date

import pytest

from app.pricing import PositionLeg, bs_price, summarise

EXP = date(2026, 12, 18)


def leg(kind, strike, qty, cost, expiry=EXP, mult=100):
    return PositionLeg(kind, strike, expiry, qty, cost, mult)


def test_bs_matches_hull_reference():
    # Hull: S=42, K=40, r=10%, vol=20%, T=0.5 -> call 4.76, put 0.81
    assert bs_price("call", 42, 40, 0.5, 0.2, 0.1) == pytest.approx(4.76, abs=0.01)
    assert bs_price("put", 42, 40, 0.5, 0.2, 0.1) == pytest.approx(0.81, abs=0.01)


def test_put_call_parity():
    import math
    c = bs_price("call", 100, 95, 0.3, 0.3, 0.05)
    p = bs_price("put", 100, 95, 0.3, 0.3, 0.05)
    assert c - p == pytest.approx(100 - 95 * math.exp(-0.05 * 0.3), abs=1e-9)


def test_short_put_spread_summary():
    legs = [leg("put", 540, -1, 3.00), leg("put", 535, 1, 1.80)]
    s = summarise(legs, 550, 0.2, 0.04)
    assert s.net_premium == 120.0
    assert s.max_profit == 120.0
    assert s.max_loss == 380.0
    assert s.breakevens == (538.8,)


def test_iron_condor_summary():
    legs = [
        leg("put", 90, 1, 0.5), leg("put", 95, -1, 1.5),
        leg("call", 105, -1, 1.5), leg("call", 110, 1, 0.5),
    ]
    s = summarise(legs, 100, 0.2, 0.04)
    assert s.max_profit == 200.0
    assert s.max_loss == 300.0
    assert s.breakevens == (93.0, 107.0)


def test_naked_short_call_has_unlimited_loss():
    s = summarise([leg("call", 100, -1, 2.0)], 100, 0.2, 0.04)
    assert s.max_loss is None
    assert s.max_profit == 200.0


def test_long_call_has_unlimited_profit():
    s = summarise([leg("call", 100, 2, 2.0)], 100, 0.2, 0.04)
    assert s.max_profit is None
    assert s.max_loss == 400.0


def test_covered_call_is_bounded_above():
    legs = [leg("stock", None, 100, 100.0, expiry=None, mult=1), leg("call", 105, -1, 2.0)]
    s = summarise(legs, 100, 0.2, 0.04)
    assert s.max_profit == 700.0
    assert s.breakevens == (98.0,)


def test_calendar_loss_is_bounded():
    front = leg("call", 100, -1, 2.0, expiry=date(2026, 12, 18))
    back = leg("call", 100, 1, 3.5, expiry=date(2027, 1, 15))
    s = summarise([front, back], 100, 0.25, 0.04)
    assert s.max_loss is not None and s.max_loss <= 150.0
    assert s.max_profit is not None and s.max_profit > 0


def test_zero_plateau_reports_only_its_edges():
    # Zero-cost put broken-wing butterfly: flat at $0 everywhere above 110.
    legs = [leg("put", 110, 1, 4.10), leg("put", 105, -2, 2.60), leg("put", 95, 1, 1.10)]
    s = summarise(legs, 105, 0.2, 0.04)
    assert s.breakevens == (100.0, 110.0)
    assert s.max_profit == pytest.approx(500.0) and s.max_loss == pytest.approx(500.0)


def test_single_zero_touch_is_reported_once():
    # Long 100 call bought for 0: P&L is 0 up to 100, then rises.
    s = summarise([leg("call", 100, 1, 0.0)], 100, 0.2, 0.04)
    assert s.breakevens == (100.0,)


# -- exercise style -----------------------------------------------------------------
# A put calendar like the AAPL trade: short 6 Nov 335P at 6.41, long 20 Nov 335P at 8.47,
# 2 lots, $412 debit. At the front expiry the long put is still alive.
def _put_calendar():
    front = leg("put", 335, -2, 6.41, expiry=date(2026, 11, 6))
    back = leg("put", 335, 2, 8.47, expiry=date(2026, 11, 20))
    return [front, back]


def test_american_put_calendar_cannot_lose_more_than_the_debit():
    # Deep in the money the long American put is worth at least intrinsic (exercise it now),
    # so it fully covers the short put's assignment: the worst case is the debit paid.
    s = summarise(_put_calendar(), 339.1, 0.336, 0.04, american=True)
    assert s.max_loss == pytest.approx(412.0, abs=0.01)


def test_american_is_the_default():
    assert summarise(_put_calendar(), 339.1, 0.336, 0.04).max_loss == pytest.approx(412.0, abs=0.01)


def test_european_put_calendar_keeps_the_discount_on_the_long_leg():
    # A European put can't be exercised early, so deep ITM it is worth K*e^(-rT) < intrinsic,
    # and the calendar can lose a little more than the debit. That is real for index options.
    s = summarise(_put_calendar(), 339.1, 0.336, 0.04, american=False)
    assert s.max_loss > 412.0 + 50


def test_american_floor_does_not_change_near_the_money_values():
    from app.pricing import leg_value
    back = _put_calendar()[1]
    eu = leg_value(back, 335.0, date(2026, 11, 6), 0.3, 0.04, american=False)
    am = leg_value(back, 335.0, date(2026, 11, 6), 0.3, 0.04, american=True)
    assert am == pytest.approx(eu)


@pytest.mark.parametrize("symbol, style", [
    ("AAPL", "american"), ("spy", "american"), ("QQQ", "american"),
    ("SPX", "european"), ("spx", "european"), ("NDX", "european"), ("RUT", "european"),
    ("XSP", "european"), ("XJO", "european"), ("VIX", "european"),
])
def test_exercise_style_by_underlying(symbol, style):
    from app.pricing import exercise_style
    assert exercise_style(symbol) == style
