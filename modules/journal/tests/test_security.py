"""Local-only guard: DNS rebinding (Host) and cross-site writes (Origin / Sec-Fetch-Site)."""
from __future__ import annotations

import pytest

from app.config import load_settings
from app.security import check_request
from tests.conftest import PNG, data, put_spread

ALLOWED = ("127.0.0.1", "localhost")


@pytest.mark.parametrize("host,allowed", [
    ("127.0.0.1:8000", True),
    ("localhost", True),
    ("LOCALHOST:3000", True),
    ("evil.example:8000", False),
    ("127.0.0.1.evil.com", False),
    ("", False),
    (None, False),
])
def test_host_header(host, allowed):
    assert (check_request("GET", host, None, None, ALLOWED) is None) is allowed


@pytest.mark.parametrize("method,origin,site,blocked", [
    ("POST", "https://evil.example", None, True),
    ("POST", "null", None, True),
    ("DELETE", "http://127.0.0.1.evil.com", None, True),
    ("POST", "https://127.0.0.1:3000", None, True),          # not http
    ("PATCH", "http://localhost:3000", None, False),         # the gateway, any port
    ("POST", "http://127.0.0.1:8000", None, False),
    ("POST", None, "cross-site", True),
    ("POST", None, "same-origin", False),
    ("POST", None, None, False),                             # curl, scripts
    ("GET", "https://evil.example", "cross-site", False),    # reads: CORS already blocks them
])
def test_unsafe_methods_need_local_origin(method, origin, site, blocked):
    result = check_request(method, "127.0.0.1:8000", origin, site, ALLOWED)
    assert (result is not None and result[0] == 403) is blocked


def test_allowed_hosts_from_env(monkeypatch):
    monkeypatch.setenv("TRADELOG_ALLOWED_HOSTS", " 127.0.0.1 , Box.Local ")
    assert load_settings().allowed_hosts == ("127.0.0.1", "box.local")


def test_rebinding_host_is_refused(client):
    resp = client.get("/api/journal/export.json", headers={"host": "evil.example:8000"})
    assert resp.status_code == 400 and resp.json()["ok"] is False


def test_cross_site_post_cannot_sync_ibkr(client):
    # The fixture's broker fails the test if it is ever called.
    resp = client.post("/api/journal/ibkr/sync", headers={"origin": "https://evil.example"})
    assert resp.status_code == 403


def test_cross_site_upload_refused(client):
    t = data(client.post("/api/journal/trades", json=put_spread()))
    resp = client.post(f"/api/journal/trades/{t['id']}/screenshots", headers={"sec-fetch-site": "cross-site"},
                       files={"file": ("a.png", PNG, "image/png")})
    assert resp.status_code == 403
    assert data(client.get(f"/api/journal/trades/{t['id']}"))["screenshots"] == []
