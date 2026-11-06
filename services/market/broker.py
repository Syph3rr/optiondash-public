"""Account reads over the one shared TWS connection: executions, positions and the cash
summary.

Read-only by design. The connection is the market-data one (`IbkrSource`), opened only
when the user presses Connect IBKR; nothing here connects, retries or polls TWS. The
guarded IB refuses every order send, so these reads are the only account traffic.

Failures are `CodedError`s whose code the gateway maps: "not_connected" (not connected,
connection lost, or TWS cut off from IBKR), "timeout" (TWS did not answer in time) and
"busy" (another account read is running; reads never queue).
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from errors import CodedError

log = logging.getLogger("sidecar.broker")

NEW_YORK = ZoneInfo("America/New_York")
NOT_CONNECTED = "not connected to TWS; press Connect IBKR"
CONNECTION_LOST = "connection to TWS was lost; press Connect IBKR"
BUSY = "another TWS account request is running; try again in a moment"
# Codes the gateway maps: not_connected -> 409, timeout -> 504, busy -> 409.
NOT_CONNECTED_CODE = "not_connected"
TIMEOUT_CODE = "timeout"
BUSY_CODE = "busy"
FETCH_TIMEOUT = 15.0       # a stalled TWS must not hang the request forever
COMMISSION_WAIT = 3.0      # commission reports arrive just after the executions
COMMISSION_POLL = 0.1
UNSET = 1e300              # IBKR's DBL_MAX means "no value"
TRADED_TYPES = ("OPT", "STK")
KINDS = {"C": "call", "P": "put"}


def ny_iso(when: datetime) -> str:
    """New York wall-clock time, naive, to the second. Naive inputs are taken as UTC."""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(NEW_YORK).replace(tzinfo=None).isoformat(timespec="seconds")


def _commission(fill: Any) -> float | None:
    """The fill's commission as IBKR reported it, or None while no report has arrived.

    A report is known once it names its execution, so a genuine $0 (e.g. an expiry or
    assignment) counts as known. The value is passed on unchanged: IBKR reports costs
    as positive numbers and rebates as negative ones; the journal decides how to book
    a rebate."""
    report = getattr(fill, "commissionReport", None)
    if report is None or not getattr(report, "execId", ""):
        return None
    try:
        value = float(report.commission)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or abs(value) >= UNSET:
        return None
    return value


def _multiplier(contract: Any) -> int:
    default = 100 if contract.secType == "OPT" else 1
    try:
        return int(float(contract.multiplier)) if contract.multiplier else default
    except (TypeError, ValueError):
        return default


def _contract_fields(c: Any) -> dict:
    is_option = c.secType == "OPT"
    expiry = c.lastTradeDateOrContractMonth or ""
    return {
        "symbol": (c.symbol or "").upper(),
        "sec_type": c.secType,
        "kind": KINDS.get(c.right, "call") if is_option else "stock",
        "strike": float(c.strike) if is_option else None,
        "expiry": f"{expiry[:4]}-{expiry[4:6]}-{expiry[6:8]}" if is_option and expiry else None,
        "multiplier": _multiplier(c),
        "con_id": c.conId or None,
    }


def execution_row(fill: Any) -> dict | None:
    """One ib_async Fill as a row. Combo parents (BAG) and other types give None."""
    c, e = fill.contract, fill.execution
    if c.secType not in TRADED_TYPES:
        return None
    commission = _commission(fill)
    shares = float(e.shares)
    return {
        "exec_id": e.execId,
        "order_id": e.orderId,
        "perm_id": e.permId,
        "executed_at": ny_iso(e.time),
        **_contract_fields(c),
        "qty": shares if e.side == "BOT" else -shares,
        "price": float(e.price),
        "commission": 0.0 if commission is None else commission,
        "commission_known": commission is not None,
        "account": e.acctNumber or "",
    }


def position_row(position: Any) -> dict | None:
    """One ib_async Position. IBKR's option avgCost is per contract; this is per share.
    Positions closed earlier in the session come back with quantity 0 and are skipped."""
    c = position.contract
    if c.secType not in TRADED_TYPES or float(position.position) == 0:
        return None
    fields = _contract_fields(c)
    divisor = fields["multiplier"] if c.secType == "OPT" else 1
    # The quotes API needs the option's trading class (SPY vs SPYW, SPX vs SPXW); stock has none.
    trading_class = (c.tradingClass or fields["symbol"]) if c.secType == "OPT" else None
    return {
        "account": position.account or "",
        **fields,
        "trading_class": trading_class,
        "qty": float(position.position),
        "avg_cost": round(float(position.avgCost) / divisor, 6),
    }


# The four account-summary tags the app reads, and the field each one becomes.
SUMMARY_FIELDS = {
    "TotalCashValue": "cash",
    "NetLiquidation": "net_liquidation",
    "AvailableFunds": "available_funds",
    "BuyingPower": "buying_power",
}


def _summary_number(raw: Any) -> float | None:
    """A summary figure, or None when TWS sent nothing usable. A missing figure is never
    turned into 0: "no cash data" must not read as "$0 in cash". Negative is real."""
    try:
        number = float(raw)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and abs(number) < UNSET else None


def account_rows(values: Any) -> list[dict]:
    """ib_async AccountValues as one row per account and currency, sorted by account.
    Only the four tags above are used; anything else TWS sent is ignored."""
    rows: dict[tuple[str, str], dict] = {}
    for v in values or []:
        field = SUMMARY_FIELDS.get(getattr(v, "tag", ""))
        if field is None:
            continue
        key = (v.account or "", v.currency or "")
        row = rows.setdefault(key, {
            "account": key[0], "currency": key[1], **{name: None for name in SUMMARY_FIELDS.values()}})
        row[field] = _summary_number(v.value)
    return [rows[k] for k in sorted(rows)]


class Broker:
    """Executions, positions and the cash summary from the shared source's guarded IB."""

    def __init__(
        self,
        source: Any,
        now: Callable[[], datetime] | None = None,
        fetch_timeout: float = FETCH_TIMEOUT,
        commission_wait: float = COMMISSION_WAIT,
        commission_poll: float = COMMISSION_POLL,
    ):
        self._source = source
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._fetch_timeout = fetch_timeout
        self._commission_wait = commission_wait
        self._commission_poll = commission_poll
        self._lock = asyncio.Lock()  # one account request at a time

    async def executions(self) -> dict:
        fills = await self._fetch("executions", lambda ib: ib.fetch_executions())
        fills = await self._with_commissions(fills)
        rows = [r for r in (execution_row(f) for f in fills) if r is not None]
        return {"executions": rows, "as_of": ny_iso(self._now())}

    async def positions(self) -> dict:
        found = await self._fetch("positions", lambda ib: ib.fetch_positions())
        rows = [r for r in (position_row(p) for p in found) if r is not None]
        return {"positions": rows, "as_of": ny_iso(self._now())}

    async def account(self) -> dict:
        """Cash, net liquidation, available funds and buying power, per account."""
        found = await self._fetch("account", lambda ib: ib.fetch_account_summary())
        return {"accounts": account_rows(found), "as_of": ny_iso(self._now())}

    async def _fetch(self, what: str, request: Callable[[Any], Any]) -> list:
        """One account read. Reads never queue: a second one while the first runs is
        refused as busy, so no caller waits past the gateway's timeout."""
        if self._lock.locked():
            raise CodedError(BUSY, BUSY_CODE)
        async with self._lock:
            self._require_connection()
            try:
                return list(await self._race_disconnect(request(self._source.ib)))
            except TimeoutError as exc:
                raise CodedError(
                    f"TWS did not answer the {what} request within "
                    f"{self._fetch_timeout:g}s; try again", TIMEOUT_CODE) from exc
            except ConnectionError as exc:
                log.warning("%s request failed: %r", what, exc)
                raise CodedError(CONNECTION_LOST, NOT_CONNECTED_CODE) from exc

    def _require_connection(self) -> None:
        if self._source.connected:
            return
        if getattr(self._source, "link_down", False):
            # The socket is up, so Connect would do nothing: say what is wrong instead.
            raise CodedError(f"{self._source.offline_reason}; account data returns when "
                             "TWS reconnects to IBKR", NOT_CONNECTED_CODE)
        raise CodedError(NOT_CONNECTED, NOT_CONNECTED_CODE)

    async def _race_disconnect(self, awaitable: Any) -> Any:
        """The read, unless the user presses Disconnect first: then it fails at once as
        a lost connection instead of waiting out the timeout."""
        closed = getattr(self._source, "session_closed", None)
        if closed is None:
            return await asyncio.wait_for(awaitable, self._fetch_timeout)
        fetch = asyncio.ensure_future(awaitable)
        waiter = asyncio.ensure_future(closed.wait())
        try:
            done, _ = await asyncio.wait(
                {fetch, waiter}, timeout=self._fetch_timeout,
                return_when=asyncio.FIRST_COMPLETED)
        finally:
            waiter.cancel()
        if fetch in done:
            return fetch.result()
        fetch.cancel()
        if waiter in done:
            raise ConnectionError("disconnected by the user")
        raise TimeoutError

    async def _with_commissions(self, fills: list) -> list:
        """Swap in the wrapper's copy of each fill. Commission reports arrive after the
        executions and update only the wrapper's Fill objects, never the ones returned
        by a repeat request, so `ib.fills()` is where they are read."""
        wanted = {f.execution.execId for f in fills if f.contract.secType in TRADED_TYPES}
        if not wanted:
            return fills
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._commission_wait
        while True:
            live = {f.execution.execId: f for f in self._source.ib.fills()
                    if f.execution.execId in wanted}
            if all(i in live and _commission(live[i]) is not None for i in wanted):
                break
            if loop.time() >= deadline:
                break
            await asyncio.sleep(self._commission_poll)
        return [live.get(f.execution.execId, f) for f in fills]
