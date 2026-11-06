from __future__ import annotations

from datetime import date

import pytest

from app.stats import open_risk, portfolio
from app.views import build_view


def leg(id_, kind, strike, fills, expiry="2026-12-18", mult=100):
    return {"id": id_, "trade_id": 1, "kind": kind, "strike": strike, "expiry": expiry,
            "multiplier": mult, "ibkr_con_id": None,
            "executions": [{"id": i, "leg_id": id_, "qty": q, "price": p, "commission": 0.0,
                            "executed_at": at, "event": ev, "ibkr_exec_id": None}
                           for i, (q, p, at, ev) in enumerate(fills)]}


def trade(legs, **extra):
    base = {"id": 1, "underlying": "AAPL", "strategy": "custom", "opened_at": "2026-11-02",
            "underlying_entry": 200.0, "iv_entry": 30.0, "max_risk_override": None,
            "confidence": None, "tags": [], "marks": [], "screenshots": [], "legs": legs}
    return {**base, **extra}


def test_open_trade_without_marks_has_no_pnl():
    v = build_view(trade([leg(1, "call", 210, [(1, 3.0, "2026-11-02", "open")])]), 0.04)
    assert v["status"] == "open"
    assert v["pnl"] is None and v["unrealized_pnl"] is None and v["realized_pnl"] is None
    assert v["return_on_risk"] is None and v["pct_of_max_profit"] is None
    assert v["current"]["max_profit"] is None  # long call: unlimited


def test_unlimited_risk_closed_trade_has_no_return_on_risk():
    fills = [(-1, 3.0, "2026-11-02", "open"), (1, 1.0, "2026-11-09", "close")]
    v = build_view(trade([leg(1, "call", 210, fills)]), 0.04)
    assert v["status"] == "closed" and v["realized_pnl"] == 200.0
    assert v["max_risk"] is None and v["return_on_risk"] is None
    assert v["days_held"] == 7


def test_max_risk_override_is_used():
    fills = [(-1, 3.0, "2026-11-02", "open"), (1, 1.0, "2026-11-09", "close")]
    v = build_view(trade([leg(1, "call", 210, fills)], max_risk_override=1000.0), 0.04)
    assert v["max_risk"] == 1000.0 and v["return_on_risk"] == 20.0


def test_stock_only_trade_has_no_dte():
    v = build_view(trade([leg(1, "stock", None, [(100, 50.0, "2026-11-02", "open")],
                              expiry=None, mult=1)]), 0.04)
    assert v["dte_at_entry"] is None
    assert v["initial"]["max_loss"] == 5000.0


def test_trade_with_no_executions_is_open_and_empty():
    v = build_view(trade([]), 0.04)
    assert v["status"] == "open" and v["initial"] is None and v["current"] is None


def test_dte_buckets_and_open_risk():
    def closed(id_, expiry, pnl):
        fills = [(-1, 3.0, "2026-11-02", "open"), (1, 3.0 - pnl / 100, "2026-11-03", "close")]
        return build_view({**trade([leg(id_, "put", 100, fills, expiry=expiry)]), "id": id_}, 0.04)

    views = [closed(1, "2026-11-02", 100), closed(2, "2026-11-05", 50),
             closed(3, "2026-11-20", -30), closed(4, "2027-06-18", 10)]
    keys = [r["key"] for r in portfolio(views)["by_dte"]]
    assert keys == ["0DTE", "1-7", "8-21", "90+"]
    open_view = build_view(trade([leg(9, "put", 100, [(-1, 2.0, "2026-11-02", "open")])]), 0.04)
    assert open_risk([open_view]) == [{"expiry": "2026-12-18", "risk": pytest.approx(9800.0), "unlimited": 0}]


def test_open_risk_falls_back_to_override_for_unlimited():
    v = build_view(trade([leg(1, "call", 210, [(-1, 3.0, "2026-11-02", "open")])],
                         max_risk_override=500.0), 0.04)
    assert open_risk([v]) == [{"expiry": "2026-12-18", "risk": 500.0, "unlimited": 0}]


def test_confidence_and_tag_groups():
    fills = [(-1, 3.0, "2026-11-02", "open"), (1, 1.0, "2026-11-03", "close")]
    v = build_view(trade([leg(1, "put", 100, fills)], confidence=4,
                         tags=[{"kind": "emotion", "value": "fomo"}]), 0.04)
    p = portfolio([v])
    assert p["by_confidence"][0]["key"] == "4"
    assert p["by_emotion"][0]["key"] == "fomo"
    assert p["by_tag"] == []
    assert p["return_on_risk"][0]["ror"] is not None


def mark(at, value):
    return {"id": 1, "trade_id": 1, "marked_at": at, "position_value": value, "underlying_price": None}


def test_mark_after_last_fill_gives_unrealised():
    v = build_view(trade([leg(1, "call", 200, [(1, 5.0, "2026-11-02", "open")])],
                         marks=[mark("2026-11-05", 700)]), 0.04)
    assert v["unrealized_pnl"] == 200.0 and v["mark_stale"] is False


def test_mark_older_than_a_fill_is_stale():
    rolled = [leg(1, "call", 200, [(1, 5.0, "2026-11-02", "open"), (-1, 7.0, "2026-11-06", "roll")]),
              leg(2, "call", 210, [(1, 8.0, "2026-11-06", "roll")])]
    v = build_view(trade(rolled, marks=[mark("2026-11-05", 700)]), 0.04)
    assert v["unrealized_pnl"] is None and v["pnl"] is None and v["mark_stale"] is True


def test_mark_stale_is_none_without_marks_or_when_closed():
    open_v = build_view(trade([leg(1, "call", 200, [(1, 5.0, "2026-11-02", "open")])]), 0.04)
    assert open_v["mark_stale"] is None
    closed = [(1, 5.0, "2026-11-02", "open"), (-1, 6.0, "2026-11-04", "close")]
    closed_v = build_view(trade([leg(1, "call", 200, closed)], marks=[mark("2026-11-03", 550)]), 0.04)
    assert closed_v["mark_stale"] is None and closed_v["realized_pnl"] == 100.0


def _closed_with(id_, pnl, expiry="2026-12-18", opened="2026-11-02"):
    fills = [(-1, 3.0, opened, "open"), (1, 3.0 - pnl / 100, "2026-11-03", "close")]
    return build_view(trade([leg(1, "put", 200, fills, expiry=expiry)], id=id_, opened_at=opened), 0.04)


def test_scratch_trades_are_not_losses():
    h = portfolio([_closed_with(1, 100), _closed_with(2, 0), _closed_with(3, -50)])["headline"]
    assert h["scratches"] == 1
    assert h["win_rate"] == pytest.approx(33.3)
    assert h["avg_loss"] == pytest.approx(-50.0)


def test_negative_dte_counts_as_zero_dte():
    v = _closed_with(1, 10, expiry="2026-11-01", opened="2026-11-02")
    assert v["dte_at_entry"] < 0
    assert [r["key"] for r in portfolio([v])["by_dte"]] == ["0DTE"]


def test_open_risk_counts_unlimited_positions():
    naked = build_view(trade([leg(1, "call", 200, [(-1, 3.0, "2026-11-02", "open")])]), 0.04)
    assert open_risk([naked]) == [{"expiry": "2026-12-18", "risk": 0.0, "unlimited": 1}]


def _closed_view(open_day, close_day, pnl_per_share, trade_id=1):
    fills = [(-1, 3.0, open_day, "open"), (1, 3.0 - pnl_per_share, close_day, "close")]
    return build_view(trade([leg(1, "put", 190, fills)], id=trade_id, opened_at=open_day), 0.04)


def test_weekday_and_hold_breakdowns():
    # 2026-11-02 is a Monday, 11-04 a Wednesday, 11-09 a Monday.
    views = [
        _closed_view("2026-11-02", "2026-11-04", 1.0, 1),   # +$100, Mon -> Wed, 2 days
        _closed_view("2026-11-02", "2026-11-02", -0.5, 2),  # -$50,  Mon -> Mon, same day
        _closed_view("2026-11-04", "2026-11-09", 2.0, 3),   # +$200, Wed -> Mon, 5 days
    ]
    s = portfolio(views)
    opened = {r["key"]: r for r in s["by_weekday_open"]}
    assert opened["Mon"]["trades"] == 2 and opened["Mon"]["pnl"] == 50.0
    assert opened["Wed"]["trades"] == 1 and opened["Wed"]["pnl"] == 200.0
    closed = {r["key"]: r for r in s["by_weekday_close"]}
    assert closed["Mon"]["trades"] == 2 and closed["Wed"]["trades"] == 1
    hold = {r["key"]: r for r in s["by_hold"]}
    assert hold["Same day"]["pnl"] == -50.0
    assert hold["1-2 days"]["pnl"] == 100.0
    assert hold["3-7 days"]["pnl"] == 200.0


def test_weekday_rows_are_ordered_monday_first_and_skip_empty_days():
    views = [_closed_view("2026-11-06", "2026-11-09", 1.0, 1)]   # Fri -> Mon
    s = portfolio(views)
    assert [r["key"] for r in s["by_weekday_open"]] == ["Fri"]
    assert [r["key"] for r in s["by_weekday_close"]] == ["Mon"]


def test_new_breakdowns_are_empty_with_no_closed_trades():
    s = portfolio([])
    assert s["by_weekday_open"] == [] and s["by_weekday_close"] == [] and s["by_hold"] == []


def _aapl_put_calendar(underlying="AAPL"):
    front = leg(1, "put", 335, [(-2, 6.41, "2026-11-02", "open")], expiry="2026-11-06")
    back = leg(2, "put", 335, [(2, 8.47, "2026-11-02", "open")], expiry="2026-11-20")
    return trade([front, back], underlying=underlying, underlying_entry=339.1, iv_entry=33.6)


def test_stock_option_calendar_max_risk_is_the_debit():
    v = build_view(_aapl_put_calendar(), 0.04)
    assert v["max_risk"] == pytest.approx(412.0, abs=0.01)


def test_index_option_calendar_max_risk_includes_the_european_discount():
    v = build_view(_aapl_put_calendar(underlying="SPX"), 0.04)
    assert v["max_risk"] > 412.0
