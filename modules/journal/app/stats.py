"""Portfolio analytics over computed trade views. Closed trades drive performance stats."""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Callable, Iterable

DTE_BUCKETS = ((0, 0, "0DTE"), (1, 7, "1-7"), (8, 21, "8-21"), (22, 45, "22-45"),
               (46, 90, "46-90"), (91, 10_000, "90+"))


def _closed(views: Iterable[dict]) -> list[dict]:
    return sorted((v for v in views if v["status"] == "closed"),
                  key=lambda v: (v["closed_at"], v["id"]))


def headline(closed: list[dict]) -> dict:
    pnls = [v["realized_pnl"] for v in closed]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]          # a $0 trade is a scratch, not a loss
    gross_win, gross_loss = sum(wins), -sum(losses)
    n = len(pnls)
    return {
        "trades": n,
        "scratches": n - len(wins) - len(losses),
        "total_pnl": round(sum(pnls), 2),
        "win_rate": round(len(wins) / n * 100, 1) if n else None,
        "avg_win": round(gross_win / len(wins), 2) if wins else None,
        "avg_loss": round(-gross_loss / len(losses), 2) if losses else None,
        "expectancy": round(sum(pnls) / n, 2) if n else None,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss else None,
        "largest_win": round(max(pnls), 2) if pnls else None,
        "largest_loss": round(min(pnls), 2) if pnls else None,
        "avg_days_held": round(sum(v["days_held"] for v in closed) / n, 1) if n else None,
        "commissions": round(sum(v["commissions"] for v in closed), 2),
    }


def equity_curve(closed: list[dict]) -> list[dict]:
    total, peak, out = 0.0, 0.0, []
    for v in closed:
        total += v["realized_pnl"]
        peak = max(peak, total)
        out.append({"date": v["closed_at"], "id": v["id"], "underlying": v["underlying"],
                    "pnl": v["realized_pnl"], "equity": round(total, 2),
                    "drawdown": round(total - peak, 2)})
    return out


def _group(closed: list[dict], key: Callable[[dict], Iterable[str]]) -> list[dict]:
    acc: dict[str, list[float]] = defaultdict(list)
    for v in closed:
        for k in key(v):
            acc[k].append(v["realized_pnl"])
    rows = [{"key": k, "trades": len(p), "pnl": round(sum(p), 2),
             "win_rate": round(sum(1 for x in p if x > 0) / len(p) * 100, 1)}
            for k, p in acc.items()]
    return sorted(rows, key=lambda r: r["pnl"], reverse=True)


WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
HOLD_BUCKETS = ((0, 0, "Same day"), (1, 2, "1-2 days"), (3, 7, "3-7 days"),
                (8, 21, "8-21 days"), (22, 10_000, "22+ days"))


def _weekday(field: str) -> Callable[[dict], list[str]]:
    def key(v: dict) -> list[str]:
        return [WEEKDAYS[date.fromisoformat(v[field]).weekday()]]
    return key


def _hold_bucket(v: dict) -> list[str]:
    d = max(v["days_held"], 0)
    return [label for lo, hi, label in HOLD_BUCKETS if lo <= d <= hi]


def _ordered(rows: list[dict], order: tuple) -> list[dict]:
    """Rows in a fixed calendar-style order (not by P&L); unseen keys are dropped."""
    return sorted(rows, key=lambda r: order.index(r["key"]))


def _dte_bucket(v: dict) -> list[str]:
    d = v["dte_at_entry"]
    if d is None:
        return ["n/a"]
    d = max(d, 0)                                 # opened on/after expiry day: treat as 0DTE
    return [label for lo, hi, label in DTE_BUCKETS if lo <= d <= hi]


def _tags(kind: str) -> Callable[[dict], list[str]]:
    def key(v: dict) -> list[str]:
        values = [t["value"] for t in v["tags"] if t["kind"] == kind]
        return values or (["(none)"] if kind == "mistake" else [])
    return key


def open_risk(views: Iterable[dict]) -> list[dict]:
    """Capital at risk in open trades, grouped by their nearest expiry. Positions with
    unlimited loss and no max-risk override are counted in `unlimited`, not as $0."""
    risk: dict[str, float] = defaultdict(float)
    unlimited: dict[str, int] = defaultdict(int)
    for v in views:
        if v["status"] != "open":
            continue
        expiries = [l["expiry"] for l in v["legs"] if l["expiry"] and l["net_qty"]]
        key = min(expiries) if expiries else "no expiry"
        amount = (v["current"] or {}).get("max_loss")
        if amount is None:
            amount = v.get("max_risk_override")
        risk[key] += amount or 0.0
        unlimited[key] += amount is None
    return [{"expiry": k, "risk": round(risk[k], 2), "unlimited": unlimited[k]}
            for k in sorted(risk)]


def portfolio(views: list[dict]) -> dict:
    closed = _closed(views)
    open_trades = [v for v in views if v["status"] == "open"]
    return {
        "as_of": date.today().isoformat(),
        "headline": {**headline(closed), "open_trades": len(open_trades)},
        "equity": equity_curve(closed),
        "by_month": sorted(_group(closed, lambda v: [v["closed_at"][:7]]), key=lambda r: r["key"]),
        "by_strategy": _group(closed, lambda v: [v["strategy"]]),
        "by_underlying": _group(closed, lambda v: [v["underlying"]]),
        "by_dte": sorted(_group(closed, _dte_bucket),
                         key=lambda r: [b[2] for b in DTE_BUCKETS].index(r["key"])
                         if r["key"] != "n/a" else 99),
        "by_weekday_open": _ordered(_group(closed, _weekday("opened_at")), WEEKDAYS),
        "by_weekday_close": _ordered(_group(closed, _weekday("closed_at")), WEEKDAYS),
        "by_hold": _ordered(_group(closed, _hold_bucket), tuple(b[2] for b in HOLD_BUCKETS)),
        "by_confidence": sorted(_group(closed, lambda v: [str(v["confidence"] or "unrated")]),
                                key=lambda r: r["key"]),
        "by_mistake": _group(closed, _tags("mistake")),
        "by_emotion": _group(closed, _tags("emotion")),
        "by_tag": _group(closed, _tags("tag")),
        "return_on_risk": [{"id": v["id"], "underlying": v["underlying"], "ror": v["return_on_risk"]}
                           for v in closed if v["return_on_risk"] is not None],
        "daily": _group(closed, lambda v: [v["closed_at"]]),
        "open_risk": open_risk(views),
    }
