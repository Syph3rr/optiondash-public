"""Keep the API local: refuse foreign Host headers and cross-site writes.

The server only listens on 127.0.0.1, but a web page in the same browser can still
reach it, either through DNS rebinding (a foreign name that resolves to 127.0.0.1) or
with a plain cross-site POST, which needs no CORS preflight. So:

* the Host header must name an allowed host (any port), and
* POST/PUT/PATCH/DELETE are refused when the browser says the request is cross-site,
  through `Origin` (must be http on an allowed host, any port, so a local gateway on
  another port still works) or `Sec-Fetch-Site: cross-site`.

Requests without those browser headers (curl, scripts, tests) are allowed.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse

from .deps import fail

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

Problem = tuple[int, str]


def _host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):                       # [::1]:8000
        return host[1:host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _origin_is_local(origin: str, allowed: tuple[str, ...]) -> bool:
    try:
        parts = urlsplit(origin)
        name = (parts.hostname or "").lower()
    except ValueError:
        return False
    return parts.scheme == "http" and name in allowed


def check_request(method: str, host: str | None, origin: str | None, fetch_site: str | None,
                  allowed: tuple[str, ...]) -> Problem | None:
    """None if the request may go through, else (status, message)."""
    if not host or _host_name(host) not in allowed:
        return 400, "unknown host; open the app at http://127.0.0.1"
    if method.upper() not in UNSAFE_METHODS:
        return None
    if origin is not None and not _origin_is_local(origin, allowed):
        return 403, "cross-site requests are not allowed"
    if (fetch_site or "").lower() == "cross-site":
        return 403, "cross-site requests are not allowed"
    return None


Receive = Callable[[], Awaitable[dict]]
Send = Callable[[dict], Awaitable[None]]


class LocalOnlyMiddleware:
    """Pure ASGI middleware applying `check_request` to every HTTP request."""

    def __init__(self, app: Any, allowed_hosts: tuple[str, ...]):
        self.app = app
        self.allowed = tuple(h.lower() for h in allowed_hosts)

    async def __call__(self, scope: dict, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        problem = check_request(scope["method"], headers.get("host"), headers.get("origin"),
                                headers.get("sec-fetch-site"), self.allowed)
        if problem is None:
            await self.app(scope, receive, send)
            return
        status, message = problem
        await JSONResponse(fail(message), status_code=status)(scope, receive, send)
