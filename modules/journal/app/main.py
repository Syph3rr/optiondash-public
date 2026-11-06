"""FastAPI application factory."""
from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable
from urllib.parse import urlencode

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import db
from .accounts import Conflict
from .config import Settings, load_settings
from .deps import fail
from .ibkr.broker import BrokerClient, Fetch, IbkrError
from .repo import NotFound
from .routes import accounts, analyses, files, ibkr, portfolio, stats, trades
from .security import LocalOnlyMiddleware

log = logging.getLogger(__name__)

# The gateway proxies /journal/* and /api/journal/* here unchanged, so the journal owns
# these prefixes outright and the same URLs work standalone and behind the gateway.
API_PREFIX = "/api/journal"
PAGE_PREFIX = "/journal"
PAGES = {"/": "index.html", "/trade": "trade.html"}
# Pages that moved. IBKR import and New trade are panels on the Trades page now (its query, such as the
# analyser's ?from=analyser hand-off, is kept); the Dashboard's charts are cards on Home.
NEW_TRADE_PATH = "/new"
IBKR_PATH = "/ibkr"  # the IBKR import is a panel on the Trades page now (old bookmarks redirect)
DASHBOARD_PATH = "/dashboard"
HOME_URL = "/home"


def _validation_message(exc: RequestValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path"))
        msg = str(err.get("msg", "invalid")).removeprefix("Value error, ")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts) or "invalid request"


def _add_handlers(app: FastAPI) -> None:
    def handler(code: int, message: Callable[[Exception], str]) -> Callable:
        async def handle(_request: Request, exc: Exception) -> JSONResponse:
            return JSONResponse(fail(message(exc)), status_code=code)
        return handle

    app.add_exception_handler(NotFound, handler(404, str))
    app.add_exception_handler(Conflict, handler(409, str))
    async def broker_error(_request: Request, exc: Exception) -> JSONResponse:
        # 409 not connected, 503 broker down, 504 timed out, 502 anything else the broker said
        return JSONResponse(fail(str(exc)), status_code=getattr(exc, "status", 400))

    app.add_exception_handler(IbkrError, broker_error)
    app.add_exception_handler(ValueError, handler(400, str))
    app.add_exception_handler(
        sqlite3.IntegrityError, handler(409, lambda e: "that conflicts with data already saved"))
    app.add_exception_handler(RequestValidationError, handler(422, _validation_message))

    async def http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(fail(str(exc.detail)), status_code=exc.status_code)

    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(fail("something went wrong; see the server log"), status_code=500)

    app.add_exception_handler(StarletteHTTPException, http_error)
    app.add_exception_handler(Exception, unexpected)


# Pages and their scripts carry Last-Modified, which lets browsers reuse an old copy without
# asking (heuristic caching) and so run stale JavaScript after an update. "no-cache" makes them
# revalidate every time; an unchanged file costs only a 304.
REVALIDATE = {"Cache-Control": "no-cache"}


class RevalidatingStatic(StaticFiles):
    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers.update(REVALIDATE)
        return response


def _add_pages(app: FastAPI, settings: Settings) -> None:
    for path, filename in PAGES.items():
        def page(filename: str = filename) -> FileResponse:
            return FileResponse(settings.static_dir / filename, headers=REVALIDATE)
        app.add_api_route(PAGE_PREFIX + path, page, methods=["GET"], include_in_schema=False)

    def to_list() -> RedirectResponse:
        return RedirectResponse(PAGE_PREFIX + "/", status_code=308)
    app.add_api_route(PAGE_PREFIX, to_list, methods=["GET"], include_in_schema=False)

    def to_new_trade(request: Request) -> RedirectResponse:
        query = urlencode([("new", "1"), *((k, v) for k, v in request.query_params.multi_items() if k != "new")])
        return RedirectResponse(f"{PAGE_PREFIX}/?{query}", status_code=307)
    app.add_api_route(PAGE_PREFIX + NEW_TRADE_PATH, to_new_trade, methods=["GET"], include_in_schema=False)

    def to_import() -> RedirectResponse:
        return RedirectResponse(f"{PAGE_PREFIX}/?import=1", status_code=307)
    app.add_api_route(PAGE_PREFIX + IBKR_PATH, to_import, methods=["GET"], include_in_schema=False)

    def to_home() -> RedirectResponse:
        return RedirectResponse(HOME_URL, status_code=307)
    app.add_api_route(PAGE_PREFIX + DASHBOARD_PATH, to_home, methods=["GET"], include_in_schema=False)


def create_app(settings: Settings | None = None,
               broker_fetch: Fetch | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db.backup(settings.db_path, settings.backup_dir)
        conn = db.connect(settings.db_path)
        try:
            db.migrate(conn)
        finally:
            conn.close()
        yield

    app = FastAPI(title="Trade Logger", lifespan=lifespan)
    app.state.settings = settings
    app.state.broker = BrokerClient(settings.broker_url, broker_fetch)
    app.state.last_sync = None
    app.add_middleware(LocalOnlyMiddleware, allowed_hosts=settings.allowed_hosts)
    _add_handlers(app)
    for module in (trades, files, stats, ibkr, analyses, portfolio, accounts):
        app.include_router(module.router, prefix=API_PREFIX)
    _add_pages(app, settings)
    settings.screenshot_dir.mkdir(parents=True, exist_ok=True)
    app.mount(PAGE_PREFIX + "/static", RevalidatingStatic(directory=settings.static_dir), name="static")
    app.mount(PAGE_PREFIX + "/screenshots", StaticFiles(directory=settings.screenshot_dir),
              name="screenshots")
    return app
