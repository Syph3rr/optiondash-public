"""Client for the platform's shared TWS connection (the broker), reached through the gateway.

The journal no longer talks to TWS itself. OptionDash owns the one TWS connection; the
journal asks the gateway's `/api/broker/executions` for fills when the user presses Sync.
Nothing here connects to TWS, and nothing runs unless a request asks for it.
"""
from __future__ import annotations

import math
from typing import Any, Awaitable, Callable, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

# Longer than the gateway's own executions timeout, so the gateway's 504 (with its message)
# arrives before this one fires; shorter than the gateway's 40 s proxy timeout.
FETCH_TIMEOUT_S = 30.0
NOT_CONNECTED = "Not connected to TWS. Press Connect on the TWS chip in the nav first."
TIMED_OUT = "TWS did not answer in time; try Sync again."
MAX_FILLS = 5000

# (status code, parsed JSON body or None). Injectable so tests never open a socket.
Fetch = Callable[[str, float], Awaitable[tuple[int, Any]]]


class IbkrError(RuntimeError):
    """A sync could not get fills from the broker; the message is shown to the user.
    `status` is the HTTP status the journal answers with: 409 not connected, 503 broker
    unavailable, 504 timed out, 502 any other broker failure."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class BrokerFill(BaseModel):
    """One execution as the broker reports it. Unknown keys are ignored."""
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)

    # The IBKR account number (e.g. U1234567); picks the journal account a trade goes to.
    account: str = Field(default="", max_length=32)
    exec_id: str = Field(min_length=1, max_length=100)
    order_id: int | None = None
    perm_id: int | None = None
    executed_at: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$")
    symbol: str = Field(min_length=1, max_length=20)
    sec_type: Literal["OPT", "STK"]
    kind: Literal["call", "put", "stock"]
    strike: float | None = Field(default=None, gt=0, lt=1_000_000)
    expiry: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    multiplier: int = Field(gt=0, le=10_000)
    qty: float = Field(gt=-1_000_000, lt=1_000_000)
    price: float = Field(ge=0, lt=1_000_000)
    # A rebate arrives negative; journal commissions are costs, so it is stored as 0.
    commission: float = Field(default=0.0, gt=-100_000, lt=100_000)
    commission_known: bool = True
    con_id: int | None = None

    @field_validator("qty")
    @classmethod
    def _nonzero(cls, v: float) -> float:
        if v == 0 or not math.isfinite(v):
            raise ValueError("quantity cannot be zero")
        return v

    def row(self) -> dict:
        """The ibkr_fills row. A commission TWS has not reported yet is stored as 0 with
        commission_known 0, and a later sync fills it in (see importer.store_fills)."""
        return {
            "exec_id": self.exec_id, "order_id": self.order_id, "perm_id": self.perm_id,
            "executed_at": self.executed_at[:19], "symbol": self.symbol.upper(),
            "sec_type": self.sec_type, "kind": self.kind,
            "strike": self.strike if self.kind != "stock" else None,
            "expiry": self.expiry if self.kind != "stock" else None,
            "multiplier": self.multiplier, "qty": self.qty, "price": self.price,
            "commission": max(self.commission, 0.0) if self.commission_known else 0.0,
            "commission_known": 1 if self.commission_known else 0,
            "con_id": self.con_id,
            "account": self.account.strip(),
        }


async def httpx_get(url: str, timeout: float) -> tuple[int, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers={"Accept": "application/json"})
    try:
        body = resp.json()
    except ValueError:
        body = None
    return resp.status_code, body


def _error_text(body: Any) -> str:
    if isinstance(body, dict):
        for key in ("error", "message", "detail"):
            if isinstance(body.get(key), str) and body[key]:
                return body[key]
    return ""


def _status_error(status: int, text: str) -> IbkrError:
    """The gateway's own message is kept; the journal answers with a matching status."""
    if status == 409:
        return IbkrError(text or NOT_CONNECTED, 409)
    if status == 503:
        return IbkrError(f"Broker unavailable: {text or 'the market service is offline'}", 503)
    if status == 504:
        return IbkrError(text or TIMED_OUT, 504)
    return IbkrError(f"Broker error ({status}): {text or 'unexpected reply'}", 502)


class BrokerClient:
    def __init__(self, base_url: str, fetch: Fetch | None = None):
        self._base = base_url.rstrip("/")
        self._fetch = fetch or httpx_get

    async def _get(self, path: str) -> Any:
        url = f"{self._base}{path}"
        try:
            status, body = await self._fetch(url, FETCH_TIMEOUT_S)
        except httpx.TimeoutException as exc:
            raise IbkrError(f"The broker did not answer within {FETCH_TIMEOUT_S:.0f} s.", 504) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise IbkrError(
                "Broker unavailable: could not reach the OptionDash gateway. "
                "Open the journal through OptionDash (cargo run).", 503) from exc
        if status == 200:
            return body
        raise _status_error(status, _error_text(body))

    async def executions(self) -> list[dict]:
        """Fills from TWS as ibkr_fills rows. Raises IbkrError with a user-facing message."""
        body = await self._get("/executions")
        raw = body.get("executions") if isinstance(body, dict) else None
        if not isinstance(raw, list) or len(raw) > MAX_FILLS:
            raise IbkrError("The broker sent an unexpected reply (no executions list).")
        # Combo parents (BAG) and other types are not journal fills; skip rather than fail.
        wanted = [i for i in raw if not (isinstance(i, dict) and i.get("sec_type") not in ("OPT", "STK"))]
        try:
            fills = [BrokerFill.model_validate(item) for item in wanted]
        except ValidationError as exc:
            first = exc.errors()[0]
            where = ".".join(str(p) for p in first.get("loc", ()))
            raise IbkrError(f"The broker sent an invalid fill ({where}: {first.get('msg')}).") from exc
        return [f.row() for f in fills]
