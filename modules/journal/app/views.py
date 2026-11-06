"""Computed views of trades: status, P&L and risk.

Charts are priced by the gateway's Rust engine (/api/analyze); this module only keeps the
expiry maths that the journal's own stats need."""
from __future__ import annotations

from dataclasses import asdict
from datetime import date

from .ledger import Fill, LegBook, book_for, cumulative_cash, opening_book
from .pricing import PositionLeg, exercise_style, first_expiry, summarise

DEFAULT_VOL = 0.30


def _fills(leg: dict) -> list[Fill]:
    return [
        Fill(e["qty"], e["price"], e["commission"], leg["multiplier"], e["executed_at"], e["event"],
             seq=e["id"])
        for e in leg["executions"]
    ]


def _expiry(leg: dict) -> date | None:
    return date.fromisoformat(leg["expiry"]) if leg["expiry"] else None


def _position(legs: list[dict], books: list[LegBook]) -> list[PositionLeg]:
    return [
        PositionLeg(leg["kind"], leg["strike"], _expiry(leg), b.net_qty, b.avg_cost, leg["multiplier"])
        for leg, b in zip(legs, books) if not b.is_flat
    ]


def _vol(trade: dict) -> float:
    return (trade.get("iv_entry") or DEFAULT_VOL * 100) / 100


def positions(trade: dict) -> dict[str, list[PositionLeg]]:
    legs = trade["legs"]
    return {
        "current": _position(legs, [book_for(_fills(l)) for l in legs]),
        "initial": _position(legs, [opening_book(_fills(l)) for l in legs]),
    }


def _summary_dict(legs: list[PositionLeg], spot: float | None, vol: float, rate: float,
                  american: bool = True) -> dict:
    return asdict(summarise(legs, spot, vol, rate, american)) if legs else None


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b[:10]) - date.fromisoformat(a[:10])).days


def _mark_state(marks: list[dict], closed: bool, last_day: str | None,
                cash: float) -> tuple[float | None, bool | None]:
    """(unrealised P&L, mark_stale). A mark older than the latest fill describes a
    position that no longer exists, so it is not used."""
    if closed or not marks:
        return None, None
    latest = marks[-1]
    if last_day is not None and latest["marked_at"][:10] < last_day:
        return None, True
    return round(cash + latest["position_value"], 2), False


def build_view(trade: dict, rate: float) -> dict:
    legs_out, books, all_fills = [], [], []
    for leg in trade["legs"]:
        fills = _fills(leg)
        book = book_for(fills)
        books.append(book)
        all_fills.extend(fills)
        legs_out.append({**leg, "net_qty": round(book.net_qty, 6), "avg_cost": round(book.avg_cost, 4),
                         "realized": round(book.realized, 2)})
    has_fills = bool(all_fills)
    closed = has_fills and all(b.is_flat for b in books)
    last_fill = max((f.executed_at[:10] for f in all_fills), default=None)
    cash = round(sum(b.cash_flow for b in books), 2)
    commissions = round(sum(b.commissions for b in books), 2)
    realized = round(sum(b.realized for b in books) - commissions, 2) if closed else None
    pos = positions(trade)
    vol, spot = _vol(trade), trade.get("underlying_entry")
    american = exercise_style(trade.get("underlying")) == "american"
    initial = _summary_dict(pos["initial"], spot, vol, rate, american)
    max_risk = trade.get("max_risk_override") or (initial or {}).get("max_loss")
    opening_expiry = first_expiry(pos["initial"])
    unrealized, mark_stale = _mark_state(trade["marks"], closed, last_fill, cash)
    pnl = realized if closed else unrealized
    return {
        **{k: v for k, v in trade.items() if k != "legs"},
        "legs": legs_out,
        "status": "closed" if closed else "open",
        "closed_at": last_fill if closed else None,
        "days_held": _days(trade["opened_at"], last_fill if closed else date.today().isoformat()),
        "dte_at_entry": (opening_expiry - date.fromisoformat(trade["opened_at"])).days
        if opening_expiry else None,
        "commissions": commissions,
        "cash_flow": cash,
        "realized_pnl": realized,
        "unrealized_pnl": unrealized,
        "mark_stale": mark_stale,
        "pnl": pnl,
        "initial": initial,
        "current": _summary_dict(pos["current"], spot, vol, rate, american) if not closed else None,
        "max_risk": max_risk,
        "return_on_risk": round(pnl / max_risk * 100, 1) if pnl is not None and max_risk else None,
        "pct_of_max_profit": _pct_max_profit(pnl, initial),
        "timeline": _timeline(all_fills, trade["marks"]),
    }


def _pct_max_profit(pnl: float | None, initial: dict | None) -> float | None:
    if pnl is None or not initial or not initial.get("max_profit"):
        return None
    return round(pnl / initial["max_profit"] * 100, 1)


def _timeline(fills: list[Fill], marks: list[dict]) -> list[dict]:
    """Cash after each fill, then mark-to-market points (cash so far + position value)."""
    points = [{"at": at, "pnl": v, "kind": "fill"} for at, v in cumulative_cash(fills)]
    for m in marks:
        cash = sum(-f.qty * f.price * f.multiplier - f.commission
                   for f in fills if f.executed_at[:10] <= m["marked_at"][:10])
        points.append({"at": m["marked_at"], "pnl": round(cash + m["position_value"], 2), "kind": "mark"})
    # Stable sort by day only: fills keep their ledger order, marks go after the day's fills.
    return sorted(points, key=lambda p: (p["at"][:10], p["kind"] == "mark"))
