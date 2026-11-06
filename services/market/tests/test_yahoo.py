from datetime import datetime, timezone

import pandas as pd

from contracts import resolve
from yahoo import YahooSource

SPX = resolve("SPX")
AAPL = resolve("AAPL")
COLUMNS = [
    "contractSymbol", "lastTradeDate", "strike", "lastPrice", "bid", "ask",
    "change", "percentChange", "volume", "openInterest", "impliedVolatility",
    "inTheMoney",
]


def make_frame(rows, drop=()):
    data = [
        {
            "contractSymbol": sym, "lastTradeDate": pd.Timestamp("2026-10-30"),
            "strike": strike, "lastPrice": last, "bid": bid, "ask": ask,
            "change": 0.0, "percentChange": 0.0, "volume": vol,
            "openInterest": oi, "impliedVolatility": iv, "inTheMoney": False,
        }
        for sym, strike, last, bid, ask, vol, oi, iv in rows
    ]
    return pd.DataFrame(data, columns=COLUMNS).drop(columns=list(drop))


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class FakeWall:
    """Wall clock that advances one minute per call."""

    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return datetime(2026, 11, 1, 12, self.n, 0, tzinfo=timezone.utc)


class Counter:
    def __init__(self):
        self.n = 0
        self.dates = []


class FakeTicker:
    def __init__(self, price=7500.5, options=("2026-11-12", "2026-11-20"),
                 calls_df=None, puts_df=None, fail=None):
        self.counter = Counter()
        self.fast_info = {"lastPrice": price}
        self.options = options
        self._calls = calls_df if calls_df is not None else make_frame([])
        self._puts = puts_df if puts_df is not None else make_frame([])
        self.fail = fail

    def option_chain(self, date):
        self.counter.n += 1
        self.counter.dates.append(date)
        if self.fail and self.fail():
            raise RuntimeError("429 Too Many Requests")
        return type("Chain", (), {"calls": self._calls, "puts": self._puts})()


class CountingTicker:
    """Factory: counts constructions (spot reads) and returns a fresh fake."""

    def __init__(self, fail=None):
        self.calls = 0
        self.fail = fail

    def __call__(self, symbol):
        self.calls += 1
        if self.fail and self.fail():
            raise RuntimeError("429 Too Many Requests")
        return FakeTicker()


def source(ticker, clock=None, wall=None):
    return YahooSource(lambda symbol: ticker, clock or FakeClock(), wall or FakeWall())


def spx_frames():
    calls = make_frame([
        ("SPXW261112C07580000", 7580.0, 99.2, 0.0, 0.0, 5, 10, 0.00001),
        ("SPX261112C07580000", 7580.0, 50.0, 49.0, 51.0, 1, 2, 0.2),
    ])
    puts = make_frame([
        ("SPXW261112P07500000", 7500.0, 30.0, 29.0, 31.0, 0, 7, 0.3),
    ])
    return calls, puts


def test_weekend_row_marks_from_last_and_carries_no_iv():
    calls, puts = spx_frames()
    row = source(FakeTicker(calls_df=calls, puts_df=puts)).chain(SPX, "20261112", "SPXW")[(7580.0, "C")]
    assert (row["mark"], row["mark_kind"]) == (99.2, "last")
    assert "iv" not in row
    assert "impliedVolatility" not in row
    assert row["bid"] is None and row["ask"] is None and row["last"] == 99.2


def test_chain_row_fields_and_mid_mark():
    calls, puts = spx_frames()
    chain = source(FakeTicker(calls_df=calls, puts_df=puts)).chain(SPX, "20261112", "SPXW")
    put = chain[(7500.0, "P")]
    assert put == {
        "bid": 29.0, "ask": 31.0, "last": 30.0, "mark": 30.0, "mark_kind": "mid",
        "volume": None, "open_interest": 7.0, "as_of": put["as_of"],
    }
    assert put["as_of"].endswith("Z")


def test_chain_converts_expiry_to_yahoo_format():
    calls, puts = spx_frames()
    t = FakeTicker(calls_df=calls, puts_df=puts)
    source(t).chain(SPX, "20261112", "SPXW")
    assert t.counter.dates == ["2026-11-12"]


def test_chain_keeps_only_requested_trading_class():
    calls, puts = spx_frames()
    chain = source(FakeTicker(calls_df=calls, puts_df=puts)).chain(SPX, "20261112", "SPXW")
    assert sorted(chain) == [(7500.0, "P"), (7580.0, "C")]
    assert chain[(7580.0, "C")]["last"] == 99.2  # the SPXW row, not SPX's 50.0


def test_chain_falls_back_to_next_class_when_first_has_no_rows():
    only_spx = make_frame([("SPX261120C07600000", 7600.0, 40.0, 39.0, 41.0, 3, 4, 0.2)])
    chain = source(FakeTicker(calls_df=only_spx)).chain(SPX, "20261120", "SPXW")
    assert list(chain) == [(7600.0, "C")]
    assert chain[(7600.0, "C")]["mark"] == 40.0


def test_unknown_class_with_no_rows_anywhere_returns_empty():
    calls, puts = spx_frames()
    assert source(FakeTicker(calls_df=calls.iloc[0:0], puts_df=puts.iloc[0:0])).chain(
        SPX, "20261112", "SPXW") == {}


def test_stock_class_requires_digit_after_prefix():
    df = make_frame([("AAPL261112C00200000", 200.0, 5.0, 4.9, 5.1, 1, 1, 0.3),
                     ("AAPLW261112C00200000", 200.0, 9.0, 8.0, 10.0, 1, 1, 0.3)])
    chain = source(FakeTicker(calls_df=df)).chain(AAPL, "20261112", "AAPL")
    assert chain[(200.0, "C")]["mark"] == 5.0
    assert len(chain) == 1


def test_empty_table_returns_empty_chain():
    assert source(FakeTicker()).chain(SPX, "20261112", "SPXW") == {}


def test_missing_column_returns_empty_chain():
    calls, puts = spx_frames()
    t = FakeTicker(calls_df=calls.drop(columns=["bid"]), puts_df=puts.drop(columns=["bid"]))
    assert source(t).chain(SPX, "20261112", "SPXW") == {}


def test_spot_shape_and_cleaning():
    s = source(FakeTicker(price=7500.5)).spot(SPX)
    assert s == {"price": 7500.5, "source": "yahoo", "data_type": "yahoo",
                 "as_of": "2026-11-01T12:01:00Z"}
    assert source(FakeTicker(price=float("nan"))).spot(SPX) is None


def test_spot_cached_for_30_seconds():
    clock, fake = FakeClock(), CountingTicker()
    s = YahooSource(fake, clock)
    s.spot(SPX)
    clock.t = 29
    s.spot(SPX)
    assert fake.calls == 1
    clock.t = 31
    s.spot(SPX)
    assert fake.calls == 2


def test_chain_cached_for_60_seconds():
    calls, puts = spx_frames()
    clock, t = FakeClock(), FakeTicker(calls_df=calls, puts_df=puts)
    s = source(t, clock)
    s.chain(SPX, "20261112", "SPXW")
    clock.t = 59
    s.chain(SPX, "20261112", "SPXW")
    assert t.counter.n == 1
    s.chain(SPX, "20261120", "SPXW")  # different expiry is a separate key
    assert t.counter.n == 2
    clock.t = 61
    s.chain(SPX, "20261112", "SPXW")
    assert t.counter.n == 3


def test_expiries_shape_and_first_class():
    t = FakeTicker(options=("2026-11-12", "bad", "2026-11-20"))
    assert source(t).expiries(SPX) == [
        {"expiry": "20261112", "trading_class": "SPXW"},
        {"expiry": "20261120", "trading_class": "SPXW"},
    ]
    assert source(t).expiries(AAPL)[0] == {"expiry": "20261112", "trading_class": "AAPL"}


def test_rate_limit_returns_last_value_with_original_as_of():
    clock, state = FakeClock(), {"fail": False}
    fake = CountingTicker(fail=lambda: state["fail"])
    s = YahooSource(fake, clock, FakeWall())
    first = s.spot(SPX)
    state["fail"] = True
    clock.t = 31
    assert s.spot(SPX) == first
    assert first["as_of"] == "2026-11-01T12:01:00Z"


def test_chain_rate_limit_returns_last_chain():
    calls, puts = spx_frames()
    clock, state = FakeClock(), {"fail": False}
    t = FakeTicker(calls_df=calls, puts_df=puts, fail=lambda: state["fail"])
    s = source(t, clock)
    first = s.chain(SPX, "20261112", "SPXW")
    state["fail"] = True
    clock.t = 61
    assert s.chain(SPX, "20261112", "SPXW") == first


def test_failure_without_cache_returns_empty_values():
    assert source(FakeTicker(fail=lambda: True)).chain(SPX, "20261112", "SPXW") == {}
    assert YahooSource(CountingTicker(fail=lambda: True), FakeClock()).spot(SPX) is None

    class Broken:
        @property
        def options(self):
            raise RuntimeError("boom")

    assert source(Broken()).expiries(SPX) == []


# ---------------------------------------------------------------- earnings
class EarningsTicker:
    """Yahoo's two earnings sources: the calendar (date only) and earnings dates (with a time)."""

    def __init__(self, dates=(), stamps=(), calendar_error=None, stamps_error=None):
        self._dates = list(dates)
        self._stamps = list(stamps)
        self._calendar_error = calendar_error
        self._stamps_error = stamps_error
        self.calls = 0

    @property
    def calendar(self):
        self.calls += 1
        if self._calendar_error:
            raise self._calendar_error
        return {"Earnings Date": self._dates} if self._dates else {}

    def get_earnings_dates(self, limit=12):
        if self._stamps_error:
            raise self._stamps_error
        # yfinance returns a New York index, which holds both EST and EDT stamps
        index = pd.DatetimeIndex(pd.to_datetime(self._stamps, utc=True), name="Earnings Date")
        index = index.tz_convert("America/New_York")
        return pd.DataFrame({"EPS Estimate": [1.0] * len(index)}, index=index)


def _nov(day):
    from datetime import date
    return date(2026, 11, day)


def test_earnings_date_comes_from_the_calendar_and_timing_from_a_matching_stamp():
    t = EarningsTicker(dates=[_nov(3)], stamps=["2026-11-03 16:00:00-05:00", "2026-07-30 16:00:00-04:00"])
    assert source(t).earnings(AAPL) == {"date": "2026-11-03", "when": "amc", "source": "yahoo"}


def test_a_morning_stamp_means_before_the_open():
    t = EarningsTicker(dates=[_nov(5)], stamps=["2026-11-05 07:00:00-05:00"])
    assert source(t).earnings(AAPL)["when"] == "bmo"


def test_timing_is_unknown_when_the_stamp_disagrees_with_the_calendar_or_is_midnight():
    nvda = EarningsTicker(dates=[_nov(18)], stamps=["2026-11-17 16:00:00-05:00"])
    assert source(nvda).earnings(AAPL) == {"date": "2026-11-18", "when": None, "source": "yahoo"}
    midnight = EarningsTicker(dates=[_nov(18)], stamps=["2026-11-18 00:00:00-05:00"])
    assert source(midnight).earnings(AAPL)["when"] is None


def test_a_failed_stamp_lookup_still_gives_the_date():
    t = EarningsTicker(dates=[_nov(3)], stamps_error=RuntimeError("scrape failed"))
    assert source(t).earnings(AAPL) == {"date": "2026-11-03", "when": None, "source": "yahoo"}


def test_past_reports_are_skipped_and_none_left_means_no_date():
    # FakeWall reads 2026-11-01, so a report on Oct 30 is history
    old = EarningsTicker(dates=[datetime(2026, 10, 30).date()])
    assert source(old).earnings(AAPL) == {"date": None, "when": None, "source": "yahoo"}
    fund = EarningsTicker()
    assert source(fund).earnings(AAPL)["date"] is None


def test_indices_have_no_earnings_and_never_ask_yahoo():
    t = EarningsTicker(dates=[_nov(3)])
    assert source(t).earnings(SPX)["date"] is None
    assert t.calls == 0


def test_earnings_are_cached():
    t = EarningsTicker(dates=[_nov(3)])
    src = source(t)
    src.earnings(AAPL)
    src.earnings(AAPL)
    assert t.calls == 1


def test_a_calendar_failure_gives_no_date_rather_than_an_error():
    t = EarningsTicker(calendar_error=RuntimeError("404 no fundamentals"))
    assert source(t).earnings(AAPL)["date"] is None


def test_a_failed_timing_lookup_is_retried_soon_but_a_good_one_is_kept():
    clock = FakeClock()
    flaky = EarningsTicker(dates=[_nov(3)], stamps_error=RuntimeError("scrape failed"))
    src = source(flaky, clock=clock)
    src.earnings(AAPL)
    clock.t += 11 * 60
    src.earnings(AAPL)
    assert flaky.calls == 2
    good = EarningsTicker(dates=[_nov(3)], stamps=["2026-11-03 16:00:00-05:00"])
    src = source(good, clock=clock)
    src.earnings(AAPL)
    clock.t += 11 * 60
    src.earnings(AAPL)
    assert good.calls == 1


def test_calendar_datetimes_are_read_as_dates():
    t = EarningsTicker(dates=[datetime(2026, 11, 3, 0, 0)])
    assert source(t).earnings(AAPL)["date"] == "2026-11-03"
