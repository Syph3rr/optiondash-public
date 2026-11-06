import asyncio
import copy
import logging
import threading
from datetime import datetime, timezone

import pytest

import router as router_module
from router import NotFound, Router

NOW = datetime(2026, 11, 2, 14, 0, tzinfo=timezone.utc)  # 09:00 EST
EXPIRY = "20261112"
SPOT_IBKR = {"price": 7500.0, "source": "ibkr", "data_type": "delayed_frozen",
             "as_of": "2026-11-02T13:59:00Z"}
SPOT_YAHOO = {"price": 7499.0, "source": "yahoo", "data_type": "yahoo",
              "as_of": "2026-11-02T13:58:00Z"}
# 09:00 Nov 2 to 16:00 Nov 12 is 10 days 7 hours = 10.2916667 days
DTE_PM = pytest.approx(10.2916667, abs=1e-6)


def ibkr_row(bid=98.2, ask=99.9):
    return {"bid": bid, "ask": ask, "last": 99.2, "mark": 99.05, "mark_kind": "mid",
            "delta": 0.526, "ibkr_iv": 0.1624, "data_type": "delayed_frozen",
            "source": "ibkr", "as_of": "2026-11-02T13:59:00Z"}


def yahoo_row():
    return {"bid": 10.0, "ask": 11.0, "last": 10.4, "mark": 10.5, "mark_kind": "mid",
            "volume": 5.0, "open_interest": 9.0, "as_of": "2026-11-02T13:58:00Z"}


def spec(strike, right="C", expiry=EXPIRY, tc="SPXW", symbol="SPX"):
    return {"symbol": symbol, "expiry": expiry, "strike": strike, "right": right,
            "trading_class": tc}


def key(strike, right="C", expiry=EXPIRY, tc="SPXW"):
    return (float(strike), right, expiry, tc)


class FakeIbkr:
    def __init__(self):
        self.connected = True
        self.offline_reason = None
        self.spot_result = SPOT_IBKR
        self.spot_error = None
        self.expiries_result = []
        self.expiries_error = None
        self.strikes_result = []
        self.strikes_error = None
        self.strikes_hang = False
        self.snapshot_result = {}
        self.snapshot_error = None
        self.watch_result = {}
        self.watch_error = None
        self.snapshot_calls = []
        self.spot_waits = []
        self.connects = 0
        self.connect_works = True

    async def connect(self):
        self.connects += 1
        self.connected = self.connect_works
        return self.connected

    async def spot(self, u, wait=2.0):
        self.spot_waits.append(wait)
        if self.spot_error:
            raise self.spot_error
        return self.spot_result

    async def expiries(self, u):
        if self.expiries_error:
            raise self.expiries_error
        return self.expiries_result

    async def strikes(self, u, expiry, trading_class):
        if self.strikes_hang:
            await asyncio.sleep(3600)
        if self.strikes_error:
            raise self.strikes_error
        return self.strikes_result

    async def snapshot(self, u, expiry, trading_class, strikes, wait=6.0):
        self.snapshot_calls.append(list(strikes))
        if self.snapshot_error:
            raise self.snapshot_error
        return self.snapshot_result

    def watch(self, contracts):
        if self.watch_error:
            raise self.watch_error
        out = {}
        for c in contracts:
            k = key(c["strike"], c["right"], c["expiry"], c["trading_class"])
            out[k] = self.watch_result.get(k)
        return out


class FakeYahoo:
    def __init__(self):
        self.spot_result = SPOT_YAHOO
        self.expiries_result = []
        self.chain_result = {}
        self.chain_calls = []
        self.earnings_result = {"date": "2026-11-03", "when": "amc", "source": "yahoo"}
        self.earnings_calls = []

    def spot(self, u):
        return self.spot_result

    def expiries(self, u):
        return self.expiries_result

    def earnings(self, u):
        self.earnings_calls.append(u.symbol)
        return self.earnings_result

    def chain(self, u, expiry, trading_class):
        self.chain_calls.append((expiry, trading_class))
        return self.chain_result


def make():
    ibkr, yahoo = FakeIbkr(), FakeYahoo()
    return ibkr, yahoo, Router(ibkr, yahoo, now=lambda: NOW)


def chain_args(spot=7500.0):
    args = {"symbol": "SPX", "expiry": EXPIRY, "trading_class": "SPXW"}
    return args if spot is None else {**args, "spot": spot}


def snapshot_for(strikes):
    return {(float(k), r): ibkr_row() for k in strikes for r in ("C", "P")}


async def test_spot_uses_ibkr_when_available():
    ibkr, yahoo, router = make()
    out = await router.handle("underlying", {"symbol": "SPX"})
    assert out == {**SPOT_IBKR, "symbol": "SPX", "instrument": "index",
                   "suggested_model": "european"}


async def test_spot_falls_back_when_disconnected():
    ibkr, yahoo, router = make()
    ibkr.spot_result = None
    out = await router.handle("underlying", {"symbol": "SPY"})
    assert out["source"] == "yahoo" and out["price"] == 7499.0
    assert out["instrument"] == "stock" and out["suggested_model"] == "american"


@pytest.mark.parametrize("error", [TimeoutError(), ConnectionError()])
async def test_spot_falls_back_when_ibkr_raises(error):
    ibkr, yahoo, router = make()
    ibkr.spot_error = error
    out = await router.handle("underlying", {"symbol": "SPX"})
    assert out["source"] == "yahoo"


async def test_fallback_is_per_contract():
    ibkr, yahoo, router = make()
    have, missing = spec(7580, "C"), spec(7585, "C")
    ibkr.watch_result = {key(7580): ibkr_row()}
    yahoo.chain_result = {(7585.0, "C"): yahoo_row()}
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [have, missing]})
    assert [q["source"] for q in out["quotes"]] == ["ibkr", "yahoo"]
    first, second = out["quotes"]
    assert first["delta"] == 0.526 and first["ibkr_iv"] == 0.1624
    assert second["delta"] is None and second["ibkr_iv"] is None
    assert second["mark"] == 10.5 and second["data_type"] == "yahoo"
    assert second["as_of"] == "2026-11-02T13:58:00Z"
    assert yahoo.chain_calls == [(EXPIRY, "SPXW")]


async def test_quote_shape_and_underlying():
    ibkr, yahoo, router = make()
    ibkr.watch_result = {key(7580): ibkr_row()}
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    assert out["underlying"] == SPOT_IBKR
    assert ibkr.spot_waits == [0.0]  # quotes never block on a first spot
    [q] = out["quotes"]
    assert set(q) == {"symbol", "expiry", "strike", "right", "trading_class", "multiplier",
                      "dte", "bid", "ask", "last", "mark", "mark_kind", "delta",
                      "ibkr_iv", "source", "data_type", "as_of"}
    assert q["symbol"] == "SPX" and q["strike"] == 7580.0 and q["right"] == "C"
    assert q["multiplier"] == 100 and q["trading_class"] == "SPXW"
    assert q["dte"] == DTE_PM
    assert (q["bid"], q["ask"], q["last"], q["mark"]) == (98.2, 99.9, 99.2, 99.05)


async def test_quotes_underlying_falls_back_to_yahoo_and_may_be_absent():
    ibkr, yahoo, router = make()
    ibkr.spot_result = None
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": []})
    assert out == {"underlying": SPOT_YAHOO, "quotes": []}
    yahoo.spot_result = None
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": []})
    assert out == {"underlying": router_module.NO_SPOT, "quotes": []}


async def test_quote_without_any_data_keeps_its_place():
    ibkr, yahoo, router = make()
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    [q] = out["quotes"]
    assert q["source"] is None and q["mark"] is None and q["strike"] == 7580.0


async def test_yahoo_rows_are_not_modified():
    ibkr, yahoo, router = make()
    yahoo.chain_result = {(7585.0, "C"): yahoo_row()}
    before = copy.deepcopy(yahoo.chain_result)
    await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7585)]})
    await router.handle("chain", chain_args(7585.0))
    assert yahoo.chain_result == before


async def test_chain_uses_real_strikes_for_the_expiry():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7490.0, 7500.0, 7510.0]  # 7505 exists only in other expiries
    ibkr.snapshot_result = snapshot_for([7490, 7500, 7510])
    out = await router.handle("chain", chain_args())
    assert out["expiry"] == EXPIRY and out["trading_class"] == "SPXW"
    assert out["spot"] == 7500.0
    assert out["dte"] == DTE_PM
    assert [(r["strike"], r["right"]) for r in out["rows"]] == [
        (7490.0, "C"), (7490.0, "P"), (7500.0, "C"), (7500.0, "P"),
        (7510.0, "C"), (7510.0, "P")]
    assert yahoo.chain_calls == []


async def test_chain_window_is_25_strikes():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [5000.0 + 5 * i for i in range(60)]  # 5000 .. 5295
    # spot 5140 is itself a strike; twelve strikes either side: 5080 .. 5200
    window = [5080.0 + 5 * i for i in range(25)]
    ibkr.snapshot_result = snapshot_for(window)
    out = await router.handle("chain", chain_args(5140.0))
    assert ibkr.snapshot_calls == [window]
    assert len(out["rows"]) == 50
    assert out["rows"][0]["strike"] == 5080.0 and out["rows"][-1]["strike"] == 5200.0


async def test_chain_beyond_budget_comes_from_yahoo():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7490.0, 7500.0]
    ibkr.snapshot_result = snapshot_for([7500])  # budget covered only the middle
    other = {**yahoo_row(), "mark": 1.0}
    yahoo.chain_result = {(7490.0, "C"): yahoo_row(), (7490.0, "P"): yahoo_row(),
                          (7500.0, "C"): other}
    out = await router.handle("chain", chain_args())
    got = [(r["strike"], r["right"], r["source"]) for r in out["rows"]]
    assert got == [(7490.0, "C", "yahoo"), (7490.0, "P", "yahoo"),
                   (7500.0, "C", "ibkr"), (7500.0, "P", "ibkr")]
    assert out["rows"][2]["mark"] == 99.05  # ibkr wins over yahoo's 1.0
    assert out["rows"][0]["ibkr_iv"] is None


async def test_chain_without_ibkr_strikes_uses_yahoo_strikes():
    ibkr, yahoo, router = make()
    ibkr.strikes_error = ConnectionError()
    yahoo.chain_result = {(7500.0, "P"): yahoo_row(), (7500.0, "C"): yahoo_row()}
    out = await router.handle("chain", chain_args())
    assert [(r["strike"], r["right"], r["source"]) for r in out["rows"]] == [
        (7500.0, "C", "yahoo"), (7500.0, "P", "yahoo")]


async def test_chain_ibkr_stall_falls_back_within_budget(monkeypatch):
    monkeypatch.setattr(router_module, "IBKR_CHAIN_BUDGET", 0.05)
    ibkr, yahoo, router = make()
    ibkr.strikes_hang = True
    yahoo.chain_result = {(7500.0, "C"): yahoo_row()}
    out = await asyncio.wait_for(router.handle("chain", chain_args()), 2)
    assert [r["source"] for r in out["rows"]] == ["yahoo"]


async def test_chain_keeps_ibkr_strikes_when_snapshot_times_out():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7490.0, 7500.0]
    ibkr.snapshot_error = TimeoutError()
    yahoo.chain_result = {(7490.0, "C"): yahoo_row(), (7500.0, "P"): yahoo_row()}
    out = await router.handle("chain", chain_args())
    assert [(r["strike"], r["right"]) for r in out["rows"]] == [(7490.0, "C"), (7500.0, "P")]


async def test_chain_without_spot_arg_uses_router_spot():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7500.0]
    ibkr.snapshot_result = snapshot_for([7500])
    out = await router.handle("chain", chain_args(None))
    assert out["spot"] == 7500.0


async def test_chain_without_any_spot_is_not_found():
    ibkr, yahoo, router = make()
    ibkr.spot_result = None
    yahoo.spot_result = None
    with pytest.raises(NotFound):
        await router.handle("chain", chain_args(None))


async def test_expiries_with_dte_and_fallback():
    ibkr, yahoo, router = make()
    ibkr.expiries_error = TimeoutError()
    yahoo.expiries_result = [{"expiry": EXPIRY, "trading_class": "SPXW"}]
    out = await router.handle("expiries", {"symbol": "SPX"})
    assert out["symbol"] == "SPX"
    [e] = out["expiries"]
    assert (e["expiry"], e["trading_class"]) == (EXPIRY, "SPXW")
    assert e["dte"] == DTE_PM


async def test_am_settled_expiry_dte_uses_0930():
    ibkr, yahoo, router = make()
    ibkr.expiries_result = [{"expiry": "20261103", "trading_class": "SPX"}]
    out = await router.handle("expiries", {"symbol": "SPX"})
    # 09:00 Nov 2 to 09:30 Nov 3 is 24.5 hours = 1.0208333 days
    assert out["expiries"][0]["dte"] == pytest.approx(1.0208333, abs=1e-6)


async def test_unknown_symbol_raises_not_found():
    ibkr, yahoo, router = make()
    ibkr.spot_result = None
    yahoo.spot_result = None
    with pytest.raises(NotFound):
        await router.handle("underlying", {"symbol": "ZZZZ"})
    with pytest.raises(NotFound):
        await router.handle("expiries", {"symbol": "ZZZZ"})


async def test_known_symbol_without_price_is_not_not_found():
    ibkr, yahoo, router = make()
    ibkr.spot_result = None
    yahoo.spot_result = None
    ibkr.expiries_result = [{"expiry": EXPIRY, "trading_class": "SPXW"}]
    out = await router.handle("underlying", {"symbol": "SPX"})
    assert out["price"] is None and out["symbol"] == "SPX"


async def test_status_reports_connection():
    ibkr, yahoo, router = make()
    assert await router.handle("status", {}) == {"ibkr": "connected", "reason": None}
    ibkr.connected = False
    ibkr.offline_reason = "TWS not reachable on 127.0.0.1:7496"
    assert await router.handle("status", {}) == {
        "ibkr": "disconnected", "reason": "TWS not reachable on 127.0.0.1:7496"}


async def test_status_never_starts_a_connection():
    ibkr, yahoo, router = make()
    ibkr.connected = False
    await router.handle("status", {})
    assert ibkr.connects == 0


async def test_connect_tries_once_and_reports_the_new_status():
    ibkr, yahoo, router = make()
    ibkr.connected = False
    assert await router.handle("connect", {}) == {"ibkr": "connected", "reason": None}
    assert ibkr.connects == 1


async def test_connect_reports_why_it_failed():
    ibkr, yahoo, router = make()
    ibkr.connected = False
    ibkr.connect_works = False
    ibkr.offline_reason = "TWS not reachable on 127.0.0.1:7496"
    assert await router.handle("connect", {}) == {
        "ibkr": "disconnected", "reason": "TWS not reachable on 127.0.0.1:7496"}


@pytest.mark.parametrize("op,args", [
    ("bogus", {}),
    ("underlying", {}),
    ("underlying", {"symbol": "bad symbol"}),
    ("chain", {"symbol": "SPX", "expiry": "2026-11-12", "trading_class": "SPXW"}),
    ("quotes", {"symbol": "SPX", "contracts": "nope"}),
    ("quotes", {"symbol": "SPX", "contracts": [{"strike": 1}]}),
])
async def test_bad_requests_raise_value_error(op, args):
    ibkr, yahoo, router = make()
    with pytest.raises(ValueError):
        await router.handle(op, args)


class SlowYahoo(FakeYahoo):
    """Hangs until `gate` opens, then keeps its answer, like Yahoo's cache."""

    def __init__(self):
        super().__init__()
        self.gate = threading.Event()
        self.done = threading.Event()
        self.chain_result = {(7585.0, "C"): yahoo_row()}

    def spot(self, u):
        self.gate.wait(10)
        return SPOT_YAHOO

    def chain(self, u, expiry, trading_class):
        self.gate.wait(10)
        self.done.set()
        return self.chain_result


async def test_quotes_bound_slow_yahoo_and_next_poll_has_data(monkeypatch):
    monkeypatch.setattr(router_module, "QUOTES_YAHOO_WAIT", 0.05)
    ibkr, yahoo, _ = make()
    yahoo = SlowYahoo()
    router = Router(ibkr, yahoo, now=lambda: NOW)
    ibkr.spot_result = None
    args = {"symbol": "SPX", "contracts": [spec(7585)]}
    try:
        out = await asyncio.wait_for(router.handle("quotes", args), 1)
        assert out["underlying"] == router_module.NO_SPOT
        [q] = out["quotes"]
        assert q["source"] is None and q["mark"] is None and q["strike"] == 7585.0
        yahoo.gate.set()  # the worker thread finishes and fills the cache
        while not yahoo.done.is_set():
            await asyncio.sleep(0.01)
        out = await router.handle("quotes", args)
        assert out["underlying"] == SPOT_YAHOO
        assert out["quotes"][0]["source"] == "yahoo" and out["quotes"][0]["mark"] == 10.5
    finally:
        yahoo.gate.set()


# -- underlying: one total budget, IBKR and Yahoo concurrent (R20) -------------
BUDGET = 0.3


class GatedYahoo(FakeYahoo):
    """Yahoo calls listed in `hung` block until `gate` opens (a worker thread cannot be
    cancelled, so every test opens the gate in a finally)."""

    def __init__(self, hung=()):
        super().__init__()
        self.hung = set(hung)
        self.gate = threading.Event()

    def spot(self, u):
        if "spot" in self.hung:
            self.gate.wait(10)
        return self.spot_result

    def expiries(self, u):
        if "expiries" in self.hung:
            self.gate.wait(10)
        return self.expiries_result


class SlowIbkr(FakeIbkr):
    async def spot(self, u, wait=2.0):
        await asyncio.sleep(30)


async def run_underlying(router, symbol="ZZZZ"):
    start = asyncio.get_running_loop().time()
    try:
        return await asyncio.wait_for(router.handle("underlying", {"symbol": symbol}), 2.0)
    finally:
        run_underlying.elapsed = asyncio.get_running_loop().time() - start


def test_underlying_budget_is_below_the_callers_timeout():
    assert router_module.UNDERLYING_BUDGET == 2.8


async def test_empty_expiries_give_not_found_at_the_budget_despite_a_slow_spot(monkeypatch):
    monkeypatch.setattr(router_module, "UNDERLYING_BUDGET", BUDGET)
    ibkr = FakeIbkr()
    ibkr.spot_result = None
    yahoo = GatedYahoo(hung={"spot"})
    try:
        with pytest.raises(NotFound):
            await run_underlying(Router(ibkr, yahoo, now=lambda: NOW))
        assert run_underlying.elapsed < BUDGET + 0.5
    finally:
        yahoo.gate.set()


async def test_not_found_comes_as_soon_as_both_yahoo_calls_settled(monkeypatch):
    monkeypatch.setattr(router_module, "UNDERLYING_BUDGET", 5.0)
    ibkr = FakeIbkr()
    ibkr.spot_result = None
    yahoo = GatedYahoo()
    yahoo.spot_result = None
    with pytest.raises(NotFound):
        await run_underlying(Router(ibkr, yahoo, now=lambda: NOW))
    assert run_underlying.elapsed < 1.0


async def test_hung_expiries_is_a_retryable_failure_not_not_found(monkeypatch):
    monkeypatch.setattr(router_module, "UNDERLYING_BUDGET", BUDGET)
    ibkr = FakeIbkr()
    ibkr.spot_result = None
    yahoo = GatedYahoo(hung={"expiries"})
    yahoo.spot_result = None
    try:
        with pytest.raises(TimeoutError) as info:
            await run_underlying(Router(ibkr, yahoo, now=lambda: NOW))
        assert not isinstance(info.value, NotFound)
        assert run_underlying.elapsed < BUDGET + 0.5
    finally:
        yahoo.gate.set()


async def test_slow_ibkr_with_fast_yahoo_returns_the_yahoo_price_in_budget(monkeypatch):
    monkeypatch.setattr(router_module, "UNDERLYING_BUDGET", BUDGET)
    out = await run_underlying(Router(SlowIbkr(), GatedYahoo(), now=lambda: NOW), "SPX")
    assert out["price"] == SPOT_YAHOO["price"] and out["source"] == "yahoo"
    assert run_underlying.elapsed < BUDGET + 0.5


async def test_fast_ibkr_wins_over_yahoo(monkeypatch):
    monkeypatch.setattr(router_module, "UNDERLYING_BUDGET", BUDGET)
    out = await run_underlying(Router(FakeIbkr(), GatedYahoo(), now=lambda: NOW), "SPX")
    assert out["price"] == SPOT_IBKR["price"] and out["source"] == "ibkr"


async def test_symbol_with_expiries_but_a_slow_price_still_answers_without_price(monkeypatch):
    monkeypatch.setattr(router_module, "UNDERLYING_BUDGET", BUDGET)
    ibkr = FakeIbkr()
    ibkr.spot_result = None
    yahoo = GatedYahoo(hung={"spot"})
    yahoo.expiries_result = [{"expiry": EXPIRY, "trading_class": "SPXW"}]
    try:
        out = await run_underlying(Router(ibkr, yahoo, now=lambda: NOW), "SPX")
        assert out["price"] is None and out["symbol"] == "SPX"
        assert run_underlying.elapsed < BUDGET + 0.5
    finally:
        yahoo.gate.set()


# -- strikes (R23) -------------------------------------------------------------
def strikes_args(**over):
    return {"symbol": "SPX", "expiry": EXPIRY, "trading_class": "SPXW", **over}


async def test_strikes_come_from_ibkr_when_it_has_them():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7000.0, 7500.0, 8000.0]
    yahoo.chain_result = {(1.0, "C"): yahoo_row()}
    out = await router.handle("strikes", strikes_args())
    assert out == {"symbol": "SPX", "expiry": EXPIRY, "trading_class": "SPXW",
                   "strikes": [7000.0, 7500.0, 8000.0]}
    assert yahoo.chain_calls == []


async def test_strikes_are_not_limited_to_the_chain_window():
    ibkr, _, router = make()
    ibkr.strikes_result = [float(k) for k in range(5000, 5200)]
    assert len((await router.handle("strikes", strikes_args()))["strikes"]) == 200


async def test_strikes_fall_back_to_yahoo_rows_once_each_and_sorted():
    ibkr, yahoo, router = make()
    yahoo.chain_result = {(7600.0, "C"): yahoo_row(), (7500.0, "C"): yahoo_row(),
                          (7500.0, "P"): yahoo_row()}
    assert (await router.handle("strikes", strikes_args()))["strikes"] == [7500.0, 7600.0]
    assert yahoo.chain_calls == [(EXPIRY, "SPXW")]


@pytest.mark.parametrize("error", [TimeoutError(), ConnectionError()])
async def test_strikes_fall_back_to_yahoo_when_ibkr_fails(error):
    ibkr, yahoo, router = make()
    ibkr.strikes_error = error
    yahoo.chain_result = {(7500.0, "C"): yahoo_row()}
    assert (await router.handle("strikes", strikes_args()))["strikes"] == [7500.0]


async def test_strikes_fall_back_to_yahoo_when_ibkr_stalls(monkeypatch):
    monkeypatch.setattr(router_module, "IBKR_CHAIN_BUDGET", 0.01)
    ibkr, yahoo, router = make()
    ibkr.strikes_hang = True
    yahoo.chain_result = {(7500.0, "C"): yahoo_row()}
    assert (await router.handle("strikes", strikes_args()))["strikes"] == [7500.0]


async def test_no_strikes_anywhere_is_not_found():
    _, _, router = make()
    with pytest.raises(NotFound):
        await router.handle("strikes", strikes_args())


async def test_yahoo_strikes_are_filtered_by_right():
    ibkr, yahoo, router = make()
    yahoo.chain_result = {(7500.0, "C"): yahoo_row(), (7510.0, "C"): yahoo_row(),
                          (7500.0, "P"): yahoo_row(), (7490.0, "P"): yahoo_row()}
    calls = await router.handle("strikes", strikes_args(right="C"))
    puts = await router.handle("strikes", strikes_args(right="P"))
    assert calls["strikes"] == [7500.0, 7510.0]
    assert puts["strikes"] == [7490.0, 7500.0]


async def test_yahoo_strikes_without_a_right_cover_both():
    ibkr, yahoo, router = make()
    yahoo.chain_result = {(7510.0, "C"): yahoo_row(), (7490.0, "P"): yahoo_row()}
    assert (await router.handle("strikes", strikes_args()))["strikes"] == [7490.0, 7510.0]


async def test_a_right_with_no_yahoo_rows_is_not_found():
    ibkr, yahoo, router = make()
    ibkr.connected = False
    yahoo.chain_result = {(7510.0, "C"): yahoo_row()}
    with pytest.raises(NotFound):
        await router.handle("strikes", strikes_args(right="P"))


@pytest.mark.parametrize("error", [TimeoutError(), ConnectionError()])
async def test_ibkr_failure_with_nothing_from_yahoo_is_retryable_not_missing(error):
    ibkr, yahoo, router = make()
    ibkr.strikes_error = error
    with pytest.raises(TimeoutError, match="try again"):
        await router.handle("strikes", strikes_args())


async def test_ibkr_stall_with_nothing_from_yahoo_is_retryable(monkeypatch):
    monkeypatch.setattr(router_module, "IBKR_CHAIN_BUDGET", 0.01)
    ibkr, _, router = make()
    ibkr.strikes_hang = True
    with pytest.raises(TimeoutError, match="try again"):
        await router.handle("strikes", strikes_args())


async def test_disconnected_ibkr_with_nothing_from_yahoo_is_retryable():
    """Yahoo returns nothing on a failure as well, so this says nothing about the expiry."""
    ibkr, _, router = make()
    ibkr.connected = False
    with pytest.raises(TimeoutError, match="try again"):
        await router.handle("strikes", strikes_args())


@pytest.mark.parametrize("bad", [{"symbol": "bad symbol"}, {"expiry": "2026-11-12"},
                                 {"expiry": None}, {"trading_class": ""},
                                 {"trading_class": None}, {"right": "X"}, {"right": ""},
                                 {"right": 1}])
async def test_strikes_validate_their_arguments(bad):
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7500.0]
    with pytest.raises(ValueError, match="symbol|expiry|trading_class|right"):
        await router.handle("strikes", strikes_args(**bad))
    assert yahoo.chain_calls == []


# -- an IBKR row with no mark (R26) -------------------------------------------
def one_sided_row():
    """Far out of the money: an ask, no bid, no last, and IBKR's model still quotes IV."""
    return {**ibkr_row(), "bid": None, "ask": 1.4, "last": None, "mark": None,
            "mark_kind": None, "delta": 0.03, "ibkr_iv": 0.2}


def assert_priced_by_yahoo_with_ibkr_greeks(row):
    assert (row["bid"], row["ask"], row["last"]) == (10.0, 11.0, 10.4)
    assert (row["mark"], row["mark_kind"]) == (10.5, "mid")
    assert (row["source"], row["data_type"]) == ("yahoo", "yahoo")
    assert row["as_of"] == "2026-11-02T13:58:00Z"  # the time of the price shown
    assert (row["ibkr_iv"], row["delta"]) == (0.2, 0.03)


async def test_quote_with_no_ibkr_mark_takes_its_price_from_yahoo():
    ibkr, yahoo, router = make()
    ibkr.watch_result = {key(7580): one_sided_row()}
    yahoo.chain_result = {(7580.0, "C"): yahoo_row()}
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    assert_priced_by_yahoo_with_ibkr_greeks(out["quotes"][0])


async def test_quote_with_no_ibkr_mark_and_nothing_from_yahoo_stays_ibkr():
    ibkr, yahoo, router = make()
    ibkr.watch_result = {key(7580): one_sided_row()}
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    [q] = out["quotes"]
    assert (q["source"], q["ask"], q["mark"], q["ibkr_iv"]) == ("ibkr", 1.4, None, 0.2)


async def test_quote_with_no_mark_on_either_side_keeps_ibkrs_quote():
    ibkr, yahoo, router = make()
    ibkr.watch_result = {key(7580): one_sided_row()}
    yahoo.chain_result = {(7580.0, "C"): {**yahoo_row(), "mark": None, "mark_kind": None}}
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    [q] = out["quotes"]
    assert (q["source"], q["ask"], q["bid"]) == ("ibkr", 1.4, None)


async def test_quote_with_an_ibkr_mark_asks_yahoo_for_nothing():
    ibkr, yahoo, router = make()
    ibkr.watch_result = {key(7580): ibkr_row()}
    await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    assert yahoo.chain_calls == []


async def test_chain_row_with_no_ibkr_mark_takes_its_price_from_yahoo():
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7500.0]
    ibkr.snapshot_result = {**snapshot_for([7500]), (7500.0, "P"): one_sided_row()}
    yahoo.chain_result = {(7500.0, "P"): yahoo_row()}
    out = await router.handle("chain", chain_args())
    call, put = out["rows"]
    assert (call["source"], call["mark"]) == ("ibkr", 99.05)
    assert_priced_by_yahoo_with_ibkr_greeks(put)


# -- an IBKR failure nobody planned for ---------------------------------------
BROKEN = "a bug inside the IBKR source"


@pytest.fixture
def router_log(caplog):
    caplog.set_level(logging.ERROR, logger="sidecar.router")
    return caplog


async def test_unexpected_spot_error_falls_back_and_is_logged(router_log):
    ibkr, yahoo, router = make()
    ibkr.spot_error = RuntimeError(BROKEN)
    out = await router.handle("underlying", {"symbol": "SPX"})
    assert out["source"] == "yahoo"
    assert BROKEN in router_log.text


async def test_unexpected_expiries_error_falls_back_and_is_logged(router_log):
    ibkr, yahoo, router = make()
    ibkr.expiries_error = RuntimeError(BROKEN)
    yahoo.expiries_result = [{"expiry": EXPIRY, "trading_class": "SPXW"}]
    out = await router.handle("expiries", {"symbol": "SPX"})
    assert [e["expiry"] for e in out["expiries"]] == [EXPIRY]
    assert BROKEN in router_log.text


async def test_unexpected_strikes_error_falls_back_and_is_logged(router_log):
    ibkr, yahoo, router = make()
    ibkr.strikes_error = RuntimeError(BROKEN)
    yahoo.chain_result = {(7500.0, "C"): yahoo_row()}
    out = await router.handle("chain", chain_args())
    assert [r["source"] for r in out["rows"]] == ["yahoo"]
    assert BROKEN in router_log.text


async def test_unexpected_snapshot_error_keeps_the_strikes_and_is_logged(router_log):
    ibkr, yahoo, router = make()
    ibkr.strikes_result = [7490.0, 7500.0]
    ibkr.snapshot_error = RuntimeError(BROKEN)
    yahoo.chain_result = {(7490.0, "C"): yahoo_row()}
    out = await router.handle("chain", chain_args())
    assert [r["strike"] for r in out["rows"]] == [7490.0]
    assert BROKEN in router_log.text


async def test_unexpected_watch_error_falls_back_and_is_logged(router_log):
    ibkr, yahoo, router = make()
    ibkr.watch_error = RuntimeError(BROKEN)
    yahoo.chain_result = {(7580.0, "C"): yahoo_row()}
    out = await router.handle("quotes", {"symbol": "SPX", "contracts": [spec(7580)]})
    assert out["quotes"][0]["source"] == "yahoo"
    assert BROKEN in router_log.text


async def test_cancelling_a_request_is_not_taken_for_an_ibkr_failure(router_log):
    ibkr, yahoo, router = make()
    ibkr.strikes_hang = True
    task = asyncio.create_task(router.handle("chain", chain_args()))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert router_log.text == ""


async def test_earnings_come_from_yahoo_with_the_symbol():
    ibkr, yahoo, router = make()
    out = await router.handle("earnings", {"symbol": "AAPL"})
    assert out == {"symbol": "AAPL", "date": "2026-11-03", "when": "amc", "source": "yahoo"}
    assert yahoo.earnings_calls == ["AAPL"]


async def test_earnings_reject_a_bad_symbol():
    ibkr, yahoo, router = make()
    with pytest.raises(ValueError):
        await router.handle("earnings", {"symbol": "aapl; rm"})
