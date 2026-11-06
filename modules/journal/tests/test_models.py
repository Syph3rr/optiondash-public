from datetime import date, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models import EventIn, when_iso


def test_when_iso_formats():
    assert when_iso(date(2026, 11, 5)) == "2026-11-05"
    assert when_iso(datetime(2026, 11, 5, 10, 15, 30, 999)) == "2026-11-05T10:15:30"
    utc = datetime(2026, 11, 5, 15, 15, tzinfo=timezone.utc)
    assert when_iso(utc) == "2026-11-05T10:15:00"          # New York (EST) time, naive
    plus2 = datetime(2026, 7, 1, 18, 0, tzinfo=timezone(timedelta(hours=2)))
    assert when_iso(plus2) == "2026-07-01T12:00:00"        # EDT in summer


def test_event_time_parsing():
    fill = {"leg_id": 1, "qty": 1, "price": 1}
    assert EventIn(event="close", executed_at="2026-11-05", fills=[fill]).executed_at == date(2026, 11, 5)
    timed = EventIn(event="close", executed_at="2026-11-05T10:15:00", fills=[fill]).executed_at
    assert timed == datetime(2026, 11, 5, 10, 15)
    with pytest.raises(ValidationError):
        EventIn(event="close", executed_at="yesterday", fills=[fill])
