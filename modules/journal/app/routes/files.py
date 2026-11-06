"""Screenshot uploads and data export."""
from __future__ import annotations

import csv
import io
import logging
import secrets
import sqlite3

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from .. import repo
from ..config import Settings
from ..deps import get_conn, get_settings, ok
from ..views import build_view

log = logging.getLogger(__name__)
router = APIRouter()

# Identify images by their first bytes, never by the name or content type the browser sends.
SIGNATURES = {b"\x89PNG\r\n\x1a\n": ".png", b"\xff\xd8\xff": ".jpg", b"GIF87a": ".gif", b"GIF89a": ".gif"}

EXPORT_COLUMNS = (
    "id", "underlying", "strategy", "status", "opened_at", "closed_at", "days_held",
    "dte_at_entry", "realized_pnl", "unrealized_pnl", "commissions", "max_risk",
    "return_on_risk", "pct_of_max_profit", "confidence", "iv_entry", "iv_rank_entry",
    "underlying_entry", "setup", "thesis", "lessons",
)


def _cell(value: object) -> object:
    """Stop spreadsheet apps treating journal text as a formula."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _image_ext(head: bytes) -> str | None:
    for sig, ext in SIGNATURES.items():
        if head.startswith(sig):
            return ext
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def remove_files(settings: Settings, filenames: list[str]) -> None:
    for name in filenames:
        try:
            (settings.screenshot_dir / name).unlink(missing_ok=True)
        except OSError as exc:  # leave the orphan file, but say so
            log.warning("could not delete screenshot %s: %s", name, exc)


@router.post("/trades/{trade_id}/screenshots", status_code=201)
async def upload_screenshot(
    trade_id: int,
    file: UploadFile = File(...),
    caption: str | None = Form(None, max_length=300),
    conn: sqlite3.Connection = Depends(get_conn),
    settings: Settings = Depends(get_settings),
) -> dict:
    data = await file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "image is larger than 10 MB")
    ext = _image_ext(data[:16])
    if ext is None:
        raise HTTPException(415, "only PNG, JPEG, GIF or WebP images can be uploaded")
    settings.screenshot_dir.mkdir(parents=True, exist_ok=True)
    name = f"t{trade_id}-{secrets.token_hex(8)}{ext}"
    target = settings.screenshot_dir / name
    try:
        with conn:  # row and file succeed together: a failed write rolls the row back
            shot_id = repo.add_screenshot(conn, trade_id, name, caption)
            target.write_bytes(data)
    except BaseException:
        target.unlink(missing_ok=True)  # a failed commit must not leave the file behind
        raise
    return ok({"id": shot_id, "filename": name})


@router.delete("/screenshots/{shot_id}")
def delete_screenshot(shot_id: int, conn: sqlite3.Connection = Depends(get_conn),
                      settings: Settings = Depends(get_settings)) -> dict:
    remove_files(settings, [repo.delete_screenshot(conn, shot_id)])
    return ok({"deleted": shot_id})


@router.get("/export.csv")
def export_csv(conn: sqlite3.Connection = Depends(get_conn),
               settings: Settings = Depends(get_settings)) -> Response:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(EXPORT_COLUMNS + ("tags",))
    for trade in repo.load_trades(conn):
        v = build_view(trade, settings.risk_free_rate)
        tags = "; ".join(f"{t['kind']}:{t['value']}" for t in v["tags"])
        writer.writerow([_cell(v.get(c)) for c in EXPORT_COLUMNS] + [_cell(tags)])
    return Response(buf.getvalue(), media_type="text/csv",
                     headers={"Content-Disposition": 'attachment; filename="trades.csv"'})


@router.get("/export.json")
def export_json(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    return ok(repo.load_trades(conn))
