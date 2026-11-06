import pytest

from app.ledger import Fill, book_for, cumulative_cash, opening_book


def f(qty, price, when, event="open", comm=0.0, mult=100):
    return Fill(qty, price, comm, mult, when, event)


def test_open_then_close_realises_difference():
    b = book_for([f(-1, 3.0, "2026-10-01"), f(1, 1.0, "2026-10-10", "close")])
    assert b.is_flat
    assert b.realized == pytest.approx(200.0)
    assert b.cash_flow == pytest.approx(200.0)


def test_commissions_reduce_cash_not_realised():
    b = book_for([f(-1, 3.0, "a", comm=1.0), f(1, 1.0, "b", "close", comm=1.0)])
    assert b.realized == pytest.approx(200.0)
    assert b.commissions == pytest.approx(2.0)
    assert b.cash_flow == pytest.approx(198.0)


def test_average_cost_on_scale_in_and_partial_close():
    b = book_for([f(1, 2.0, "a"), f(1, 4.0, "b", "adjust"), f(-1, 5.0, "c", "close")])
    assert b.net_qty == 1
    assert b.avg_cost == pytest.approx(3.0)
    assert b.realized == pytest.approx(200.0)


def test_flip_through_zero_reopens_at_fill_price():
    b = book_for([f(1, 2.0, "a"), f(-3, 5.0, "b", "adjust")])
    assert b.net_qty == -2
    assert b.avg_cost == pytest.approx(5.0)
    assert b.realized == pytest.approx(300.0)


def test_fills_are_ordered_by_time():
    b = book_for([f(1, 1.0, "2026-10-10", "close"), f(-1, 3.0, "2026-10-01")])
    assert b.realized == pytest.approx(200.0)


def test_opening_book_ignores_later_events():
    fills = [f(-2, 3.0, "a"), f(2, 1.0, "b", "close")]
    ob = opening_book(fills)
    assert ob.net_qty == -2 and ob.avg_cost == 3.0


def test_cumulative_cash():
    out = cumulative_cash([f(-1, 3.0, "a", comm=1), f(1, 1.0, "b", "close", comm=1)])
    assert out == [("a", 299.0), ("b", 198.0)]


def test_same_day_fills_follow_entry_order_not_string_order():
    # IBKR fills carry a time, a manual close only a date; entry order (seq) breaks the tie.
    fills = [
        Fill(1, 2.0, 0.0, 100, "2026-01-05T09:30:00", "open", seq=1),
        Fill(1, 4.0, 0.0, 100, "2026-01-05T10:00:00", "adjust", seq=2),
        Fill(-1, 3.0, 0.0, 100, "2026-01-05", "close", seq=3),
    ]
    b = book_for(fills)
    assert b.net_qty == 1 and b.avg_cost == pytest.approx(3.0) and b.realized == pytest.approx(0.0)
    assert [at for at, _ in cumulative_cash(fills)] == [
        "2026-01-05T09:30:00", "2026-01-05T10:00:00", "2026-01-05"]


def test_earlier_day_still_sorts_first_regardless_of_seq():
    fills = [Fill(1, 1.0, 0.0, 100, "2026-01-06", "close", seq=1),
             Fill(-1, 3.0, 0.0, 100, "2026-01-05T15:00:00", "open", seq=2)]
    assert book_for(fills).realized == pytest.approx(200.0)
