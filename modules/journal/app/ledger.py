"""Turn executions into positions and P&L (average-cost method, per leg)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

EPS = 1e-9


@dataclass(frozen=True)
class Fill:
    qty: float           # + bought, - sold
    price: float         # per share
    commission: float
    multiplier: int
    executed_at: str
    event: str
    seq: int = 0          # entry order (execution id): breaks ties within a day


@dataclass(frozen=True)
class LegBook:
    net_qty: float
    avg_cost: float       # per share, of what is still open
    realized: float       # $ before commissions
    commissions: float
    cash_flow: float      # $ in (+) / out (-), commissions included

    @property
    def is_flat(self) -> bool:
        return abs(self.net_qty) < EPS


EMPTY_BOOK = LegBook(0.0, 0.0, 0.0, 0.0, 0.0)


def fill_order(fill: Fill) -> tuple[str, int]:
    """By day, then entry order. Manual fills carry only a date and IBKR fills a time,
    so comparing whole strings would put every date-only fill before a timed one."""
    return fill.executed_at[:10], fill.seq


def _apply(book: LegBook, fill: Fill) -> LegBook:
    q, a, x, p, m = book.net_qty, book.avg_cost, fill.qty, fill.price, fill.multiplier
    realized = book.realized
    if abs(q) < EPS or (q > 0) == (x > 0):
        new_q = q + x
        new_a = (a * abs(q) + p * abs(x)) / abs(new_q)
    else:
        closed = min(abs(x), abs(q))
        realized += closed * (p - a) * (1 if q > 0 else -1) * m
        new_q = q + x
        if abs(new_q) < EPS:
            new_q, new_a = 0.0, 0.0
        elif (new_q > 0) == (q > 0):
            new_a = a                     # partial close keeps the open cost
        else:
            new_a = p                     # flipped through zero: remainder opened at p
    return LegBook(
        net_qty=new_q,
        avg_cost=new_a,
        realized=realized,
        commissions=book.commissions + fill.commission,
        cash_flow=book.cash_flow - x * p * m - fill.commission,
    )


def book_for(fills: Iterable[Fill]) -> LegBook:
    book = EMPTY_BOOK
    for fill in sorted(fills, key=fill_order):
        book = _apply(book, fill)
    return book


def opening_book(fills: Iterable[Fill]) -> LegBook:
    """The position as first opened: only fills with event 'open'."""
    return book_for(f for f in fills if f.event == "open")


def cumulative_cash(fills: Iterable[Fill]) -> list[tuple[str, float]]:
    """Running cash flow by execution time, for P&L timelines."""
    total, out = 0.0, []
    for f in sorted(fills, key=fill_order):
        total += -f.qty * f.price * f.multiplier - f.commission
        out.append((f.executed_at, round(total, 2)))
    return out
