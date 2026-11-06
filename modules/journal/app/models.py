"""Request schemas. Everything coming from the browser or TWS is validated here."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

LegKind = Literal["call", "put", "stock"]
Event = Literal["open", "adjust", "roll", "close", "expire", "assign"]
TagKind = Literal["tag", "emotion", "mistake"]

STRATEGIES = (
    "long_call", "long_put", "short_call", "short_put", "covered_call", "cash_secured_put",
    "bull_call_spread", "bear_put_spread", "bull_put_spread", "bear_call_spread",
    "iron_condor", "iron_butterfly", "long_butterfly", "broken_wing_butterfly",
    "long_straddle", "short_straddle", "long_strangle", "short_strangle",
    "calendar", "double_calendar", "diagonal", "ratio_spread", "jade_lizard", "stock", "custom",
)

Text = Field(default=None, max_length=10_000)
NEW_YORK = ZoneInfo("America/New_York")
QTY_LIMIT = 1_000_000
MAX_CREATE_EVENTS = 30

# An execution time: a plain date, or a date and time (naive = New York time).
# `date` is tried first, so "2026-11-05" and "2026-11-05T00:00:00" both stay dates.
When = date | datetime


def when_iso(value: date | datetime) -> str:
    """Store dates as YYYY-MM-DD and times as naive New York YYYY-MM-DDTHH:MM:SS."""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(NEW_YORK).replace(tzinfo=None)
        return value.isoformat(timespec="seconds")
    return value.isoformat()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class LegIn(Strict):
    kind: LegKind
    strike: float | None = Field(default=None, gt=0, lt=1_000_000)
    expiry: date | None = None
    multiplier: int | None = Field(default=None, gt=0, le=10_000)

    @model_validator(mode="after")
    def _shape(self) -> "LegIn":
        if self.kind == "stock":
            if self.strike is not None or self.expiry is not None:
                raise ValueError("stock legs have no strike or expiry")
        elif self.strike is None or self.expiry is None:
            raise ValueError("option legs need a strike and an expiry")
        return self

    @property
    def resolved_multiplier(self) -> int:
        return self.multiplier or (1 if self.kind == "stock" else 100)


class FillIn(Strict):
    leg_id: int | None = None
    leg: LegIn | None = None
    qty: float = Field(lt=QTY_LIMIT, gt=-QTY_LIMIT)
    price: float = Field(ge=0, lt=1_000_000)
    commission: float = Field(default=0, ge=0, lt=100_000)

    @field_validator("qty")
    @classmethod
    def _nonzero(cls, v: float) -> float:
        if v == 0:
            raise ValueError("quantity cannot be zero")
        return v

    @model_validator(mode="after")
    def _one_leg_ref(self) -> "FillIn":
        if (self.leg_id is None) == (self.leg is None):
            raise ValueError("give either leg_id (existing leg) or leg (new leg)")
        return self


class Tag(Strict):
    kind: TagKind
    value: str = Field(min_length=1, max_length=60)


class Journal(Strict):
    underlying_entry: float | None = Field(default=None, gt=0)
    iv_entry: float | None = Field(default=None, ge=0, le=1000)
    iv_rank_entry: float | None = Field(default=None, ge=0, le=100)
    max_risk_override: float | None = Field(default=None, gt=0)
    setup: str | None = Text
    thesis: str | None = Text
    planned_exit: str | None = Text
    profit_target: str | None = Field(default=None, max_length=200)
    stop_loss: str | None = Field(default=None, max_length=200)
    confidence: int | None = Field(default=None, ge=1, le=5)
    review_right: str | None = Text
    review_wrong: str | None = Text
    lessons: str | None = Text
    notes: str | None = Text


class EventIn(Strict):
    event: Event
    executed_at: When
    fills: list[FillIn] = Field(min_length=1, max_length=20)


class TradeCreate(Journal):
    underlying: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9.\-]{0,9}$")
    strategy: str
    opened_at: date
    tags: list[Tag] = Field(default_factory=list, max_length=50)
    # Left out: the first IBKR account (or the lowest id if there is none). Must exist.
    account_id: int | None = None
    fills: list[FillIn] = Field(min_length=1, max_length=20)
    # Later closes and adjustments logged together with the opening (backfilling a trade).
    events: list[EventIn] = Field(default_factory=list, max_length=MAX_CREATE_EVENTS)

    @field_validator("underlying")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    @field_validator("strategy")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in STRATEGIES:
            raise ValueError(f"unknown strategy '{v}'")
        return v

    @model_validator(mode="after")
    def _new_legs_only(self) -> "TradeCreate":
        if any(f.leg is None for f in self.fills):
            raise ValueError("a new trade's fills must each describe their leg")
        if any(f.leg is None for e in self.events for f in e.fills):
            raise ValueError("a new trade's later fills must each describe their leg "
                             "(leg ids don't exist yet)")
        return self

    @model_validator(mode="after")
    def _events_after_open(self) -> "TradeCreate":
        opened = self.opened_at.isoformat()
        for e in self.events:
            day = when_iso(e.executed_at)[:10]
            if day < opened:
                raise ValueError(f"a {e.event} on {day} is before the trade was opened ({opened})")
        return self


class TradeUpdate(Journal):
    underlying: str | None = Field(default=None, pattern=r"^[A-Za-z][A-Za-z0-9.\-]{0,9}$")
    strategy: str | None = None
    opened_at: date | None = None
    tags: list[Tag] | None = Field(default=None, max_length=50)
    account_id: int | None = None  # moves the trade to that account (must exist)

    @field_validator("strategy")
    @classmethod
    def _known(cls, v: str | None) -> str | None:
        if v is not None and v not in STRATEGIES:
            raise ValueError(f"unknown strategy '{v}'")
        return v

    @field_validator("underlying", "strategy", "opened_at", "account_id", mode="before")
    @classmethod
    def _not_null(cls, v: object) -> object:
        # Leaving the field out keeps it; sending null would blank a required column.
        if v is None:
            raise ValueError("cannot be empty; leave it out to keep the current value")
        return v


class ExecutionUpdate(Strict):
    executed_at: When | None = None
    qty: float | None = Field(default=None, lt=QTY_LIMIT, gt=-QTY_LIMIT)
    price: float | None = Field(default=None, ge=0, lt=1_000_000)
    commission: float | None = Field(default=None, ge=0, lt=100_000)
    event: Event | None = None

    @field_validator("qty")
    @classmethod
    def _nonzero(cls, v: float | None) -> float | None:
        if v == 0:
            raise ValueError("quantity cannot be zero")
        return v


class MarkIn(Strict):
    marked_at: date
    position_value: float
    underlying_price: float | None = Field(default=None, gt=0)
