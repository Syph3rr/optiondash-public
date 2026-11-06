"""Paths and settings. Everything can be overridden with environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ALLOWED_HOSTS = ("127.0.0.1", "localhost")
DEFAULT_BROKER_URL = "http://127.0.0.1:3000/api/broker"


@dataclass(frozen=True)
class Settings:
    db_path: Path
    screenshot_dir: Path
    backup_dir: Path
    static_dir: Path
    risk_free_rate: float
    # The gateway's broker API (the platform's one shared TWS connection).
    broker_url: str
    max_upload_bytes: int = 10 * 1024 * 1024
    # Host names the server answers to; anything else is refused (DNS rebinding guard).
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS


def _hosts(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return DEFAULT_ALLOWED_HOSTS
    return tuple(h.strip().lower() for h in raw.split(",") if h.strip())


def _broker_url(raw: str | None) -> str:
    url = (raw or DEFAULT_BROKER_URL).strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"BROKER_URL must be an http(s) URL, got {url!r}")
    return url


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("TRADELOG_DATA", ROOT / "data"))
    return Settings(
        db_path=data_dir / "trades.db",
        screenshot_dir=data_dir / "screenshots",
        backup_dir=data_dir / "backups",
        static_dir=ROOT / "static",
        risk_free_rate=float(os.environ.get("TRADELOG_RATE", "0.04")),
        broker_url=_broker_url(os.environ.get("BROKER_URL")),
        allowed_hosts=_hosts(os.environ.get("TRADELOG_ALLOWED_HOSTS")),
    )
