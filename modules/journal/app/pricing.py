"""Expiry maths for the journal's stats: max profit/loss and breakevens of a position.

Every chart is priced by the gateway's Rust engine (POST /api/analyze, American/BAW with
Greeks). This module only answers "what can this structure make or lose at its first
expiry", which the trade views and portfolio stats need without a network call. At expiry
that is intrinsic value, so it agrees exactly with the engine. The minimal Black-Scholes
below is used solely to value the later legs of multi-expiry structures (calendars,
diagonals) at the first expiry. For American-style options (stocks, ETFs) a live leg is
floored at intrinsic, since it can be exercised now; without that floor a deep in-the-money
European put is worth K*e^(-rT) < intrinsic, which invents a loss beyond a calendar's debit.
European-style index options (EUROPEAN_UNDERLYINGS) keep the plain European value.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

GRID_POINTS = 201
EPS = 1e-9
ZERO_PNL = 1e-6   # $: P&L this close to zero counts as zero (float noise)
# Cash-settled, European-exercise index options. Everything else (stocks, ETFs) is American.
EUROPEAN_UNDERLYINGS = frozenset({"SPX", "NDX", "RUT", "XSP", "XJO", "VIX", "DJX"})


def exercise_style(underlying: str | None) -> str:
    """'european' for the index options in EUROPEAN_UNDERLYINGS, 'american' for the rest."""
    return "european" if (underlying or "").upper() in EUROPEAN_UNDERLYINGS else "american"


@dataclass(frozen=True)
class PositionLeg:
    kind: str              # 'call' | 'put' | 'stock'
    strike: float | None
    expiry: date | None
    qty: float             # signed contracts (or shares for stock)
    cost: float            # average entry price per share
    multiplier: int = 100


@dataclass(frozen=True)
class Summary:
    max_profit: float | None   # None = unlimited
    max_loss: float | None     # None = unlimited; otherwise a positive number
    breakevens: tuple[float, ...]
    net_premium: float         # + credit received, - debit paid


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_price(kind: str, spot: float, strike: float, years: float, vol: float, rate: float) -> float:
    if years <= 0 or vol <= 0 or spot <= 0:
        return intrinsic(kind, spot, strike)
    sq = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / sq
    d2 = d1 - sq
    disc = strike * math.exp(-rate * years)
    if kind == "call":
        return spot * _norm_cdf(d1) - disc * _norm_cdf(d2)
    return disc * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def intrinsic(kind: str, spot: float, strike: float | None) -> float:
    if kind == "stock":
        return spot
    if kind == "call":
        return max(spot - strike, 0.0)
    return max(strike - spot, 0.0)


def leg_value(leg: PositionLeg, spot: float, on: date, vol: float, rate: float,
              american: bool = True) -> float:
    """Value per share of one unit of the leg on a date. A live American option is worth at
    least its intrinsic value, because it can be exercised now."""
    if leg.kind == "stock":
        return spot
    now = intrinsic(leg.kind, spot, leg.strike)
    if leg.expiry is None or leg.expiry <= on:
        return now
    years = (leg.expiry - on).days / 365.0
    value = bs_price(leg.kind, spot, leg.strike, years, vol, rate)
    return max(value, now) if american else value


def position_pnl(legs: list[PositionLeg], spot: float, on: date, vol: float, rate: float,
                 american: bool = True) -> float:
    return sum(
        leg.qty * leg.multiplier * (leg_value(leg, spot, on, vol, rate, american) - leg.cost)
        for leg in legs
    )


def first_expiry(legs: list[PositionLeg]) -> date | None:
    expiries = [leg.expiry for leg in legs if leg.expiry is not None]
    return min(expiries) if expiries else None


def _scan_grid(legs: list[PositionLeg], spot: float | None) -> list[float]:
    anchors = [leg.strike for leg in legs if leg.strike] + ([spot] if spot else [])
    if not anchors:
        anchors = [leg.cost for leg in legs if leg.cost > 0] or [100.0]
    lo, hi = min(anchors) * 0.8, max(anchors) * 1.2
    step = (hi - lo) / (GRID_POINTS - 1)
    points = {round(lo + i * step, 4) for i in range(GRID_POINTS)}
    points.update(a for a in anchors)
    return sorted(points)



def _upside_slope(legs: list[PositionLeg]) -> float:
    """P&L change per $1 far above every strike: calls and stock count, puts are worthless."""
    return sum(leg.qty * leg.multiplier for leg in legs if leg.kind in ("call", "stock"))


def _breakevens(prices: list[float], pnl: list[float]) -> tuple[float, ...]:
    """Prices where P&L crosses zero, plus the inner edges of any run of exactly-zero P&L.

    A zero run that reaches either end of the grid has no breakeven on that side: the
    grid ends are scan limits, not prices where anything changes."""
    zero = [abs(v) < ZERO_PNL for v in pnl]
    last = len(prices) - 1
    found: list[float] = []
    for i, (price, v) in enumerate(zip(prices, pnl)):
        if zero[i]:
            starts = i > 0 and not zero[i - 1]
            ends = i < last and not zero[i + 1]
            if starts or ends:
                found.append(round(price, 2))
        elif i < last and not zero[i + 1] and v * pnl[i + 1] < 0:
            p1, v1 = prices[i + 1], pnl[i + 1]
            found.append(round(price + (p1 - price) * (-v) / (v1 - v), 2))
    return tuple(found)


def summarise(legs: list[PositionLeg], spot: float | None, vol: float, rate: float,
              american: bool = True) -> Summary:
    """Max profit/loss and breakevens at the first expiry (later legs priced with BS, floored
    at intrinsic when `american`)."""
    net_premium = round(-sum(leg.qty * leg.multiplier * leg.cost for leg in legs), 2)
    if not legs:
        return Summary(0.0, 0.0, (), 0.0)
    on = first_expiry(legs) or date.today()
    strikes = [leg.strike for leg in legs if leg.strike]
    top = max(strikes + ([spot] if spot else []) + [1.0]) * 3
    prices = sorted(set([0.0] + _scan_grid(legs, spot) + strikes + [top]))
    pnl = [position_pnl(legs, p, on, vol, rate, american) for p in prices]
    slope = _upside_slope(legs)
    max_profit = None if slope > EPS else round(max(pnl), 2)
    worst = min(pnl)
    max_loss = None if slope < -EPS else round(max(-worst, 0.0), 2)
    return Summary(max_profit, max_loss, _breakevens(prices, pnl), net_premium)
