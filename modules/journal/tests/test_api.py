from __future__ import annotations

import pytest

from tests.conftest import PNG, data, opt, put_spread


def create(client, **extra) -> dict:
    resp = client.post("/api/journal/trades", json=put_spread(**extra))
    assert resp.status_code == 201, resp.json()
    return resp.json()["data"]


def legs_by_strike(view: dict) -> dict:
    return {l["strike"]: l for l in view["legs"]}


def close_all(client, trade: dict, prices: dict, when: str = "2026-11-10", event: str = "close"):
    fills = [{"leg_id": l["id"], "qty": -l["net_qty"], "price": prices[l["strike"]],
              "commission": 0.65} for l in trade["legs"] if l["net_qty"]]
    return client.post(f"/api/journal/trades/{trade['id']}/events",
                       json={"event": event, "executed_at": when, "fills": fills})


def test_create_and_get(client):
    t = create(client)
    assert t["underlying"] == "SPY"
    assert t["status"] == "open"
    assert t["initial"]["max_profit"] == 120.0
    assert t["initial"]["max_loss"] == 380.0
    assert t["max_risk"] == 380.0
    assert t["dte_at_entry"] == 46
    assert t["commissions"] == 1.3
    got = data(client.get(f"/api/journal/trades/{t['id']}"))
    assert len(got["legs"]) == 2 and got["timeline"]


def test_list_omits_timeline(client):
    create(client)
    rows = data(client.get("/api/journal/trades"))
    assert len(rows) == 1 and "timeline" not in rows[0]


def test_meta(client):
    create(client, tags=[{"kind": "emotion", "value": "Calm"}])
    m = data(client.get("/api/journal/meta"))
    assert "iron_condor" in m["strategies"]
    assert m["tags"]["emotion"] == ["calm"]


def test_patch_journal_and_tags(client):
    t = create(client)
    body = {"thesis": "support at 540", "confidence": 4,
            "tags": [{"kind": "mistake", "value": "sized too big"}, {"kind": "tag", "value": "earnings"}]}
    v = data(client.patch(f"/api/journal/trades/{t['id']}", json=body))
    assert v["thesis"] == "support at 540" and v["confidence"] == 4
    assert {"kind": "mistake", "value": "sized too big"} in v["tags"]
    v = data(client.patch(f"/api/journal/trades/{t['id']}", json={"tags": []}))
    assert v["tags"] == [] and v["thesis"] == "support at 540"


def test_close_realises_pnl(client):
    t = create(client)
    v = data(close_all(client, t, {540: 1.00, 535: 0.40}))
    assert v["status"] == "closed" and v["closed_at"] == "2026-11-10"
    # credit 120, paid back 60, four commissions of 0.65
    assert v["realized_pnl"] == pytest.approx(57.4)
    assert v["pnl"] == v["realized_pnl"]
    assert v["return_on_risk"] == pytest.approx(round(57.4 / 380 * 100, 1))
    assert v["pct_of_max_profit"] == pytest.approx(round(57.4 / 120 * 100, 1))
    assert v["current"] is None


def test_partial_close_stays_open(client):
    t = create(client, fills=[
        {"leg": opt("put", 540), "qty": -2, "price": 3.0},
        {"leg": opt("put", 535), "qty": 2, "price": 1.8},
    ])
    legs = legs_by_strike(t)
    fills = [{"leg_id": legs[540]["id"], "qty": 1, "price": 1.0},
             {"leg_id": legs[535]["id"], "qty": -1, "price": 0.4}]
    v = data(client.post(f"/api/journal/trades/{t['id']}/events",
                         json={"event": "close", "executed_at": "2026-11-05", "fills": fills}))
    assert v["status"] == "open"
    assert legs_by_strike(v)[540]["net_qty"] == -1
    assert legs_by_strike(v)[540]["realized"] == pytest.approx(200.0)


def test_roll_keeps_one_trade(client):
    t = create(client)
    legs = legs_by_strike(t)
    fills = [
        {"leg_id": legs[540]["id"], "qty": 1, "price": 4.0},
        {"leg_id": legs[535]["id"], "qty": -1, "price": 1.9},
        {"leg": opt("put", 530, "2027-01-15"), "qty": -1, "price": 3.2},
        {"leg": opt("put", 525, "2027-01-15"), "qty": 1, "price": 1.6},
    ]
    v = data(client.post(f"/api/journal/trades/{t['id']}/events",
                         json={"event": "roll", "executed_at": "2026-11-20", "fills": fills}))
    assert v["status"] == "open" and len(v["legs"]) == 4
    assert v["current"]["max_profit"] == pytest.approx(160.0)
    # initial structure is still the original spread
    assert v["initial"]["max_profit"] == 120.0
    v = data(close_all(client, v, {530: 0.0, 525: 0.0}, "2027-01-15", "expire"))
    assert v["status"] == "closed"
    # credit 120, paid 210 to close, 160 new credit; commissions: 2 at open + 2 at expiry
    assert v["realized_pnl"] == pytest.approx(120 - 210 + 160 - 0.65 * 4)


def test_expire_worthless(client):
    t = create(client)
    v = data(close_all(client, t, {540: 0.0, 535: 0.0}, "2026-12-18", "expire"))
    assert v["status"] == "closed"
    assert v["realized_pnl"] == pytest.approx(120 - 0.65 * 4)


def test_marks_give_unrealised(client):
    t = create(client)
    v = data(client.post(f"/api/journal/trades/{t['id']}/marks",
                         json={"marked_at": "2026-11-05", "position_value": -80, "underlying_price": 548}))
    assert v["unrealized_pnl"] == pytest.approx(120 - 1.3 - 80)
    assert v["timeline"][-1]["kind"] == "mark"
    mark_id = v["marks"][0]["id"]
    assert client.delete(f"/api/journal/marks/{mark_id}").status_code == 200
    assert client.delete(f"/api/journal/marks/{mark_id}").status_code == 404


def test_payoff_endpoint_is_gone(client):
    # Charts are priced by the gateway's Rust engine (/api/analyze) now.
    t = create(client)
    assert client.get(f"/api/journal/trades/{t['id']}/payoff").status_code == 404


def test_pages_live_under_journal_prefix(client):
    for path in ("/journal/", "/journal/trade"):
        r = client.get(path)
        assert r.status_code == 200 and "text/html" in r.headers["content-type"], path
    r = client.get("/journal", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "/journal/"
    assert client.get("/journal/static/js/api.js").status_code == 200
    assert client.get("/").status_code == 404 and client.get("/api/trades").status_code == 404


def test_new_trade_page_moved_into_the_trades_page(client):
    r = client.get("/journal/new", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/journal/?new=1"
    # The analyser's "Log as trade" hand-off keeps its parameter, so the prefill still loads.
    r = client.get("/journal/new?from=analyser", follow_redirects=False)
    assert r.headers["location"] == "/journal/?new=1&from=analyser"
    page = client.get("/journal/").text
    assert 'id="new-trade"' in page and 'id="open-new"' in page and "form.js" in page


def test_ibkr_page_moved_into_the_trades_page(client):
    # The standalone IBKR page is gone; old bookmarks land on the import panel.
    r = client.get("/journal/ibkr", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/journal/?import=1"
    assert client.get("/journal/ibkr/", follow_redirects=False).status_code in (307, 308, 404)
    trades = client.get("/journal/").text
    for ident in ("ibkr-import", "open-import", "connect", "disconnect", "sync", "queue", "dot", "message"):
        assert f'id="{ident}"' in trades, ident
    assert "ibkr.js" in trades
    assert client.get("/journal/static/ibkr.html").status_code == 404


def test_pages_and_static_files_are_revalidated(client):
    # Without this, browsers may reuse an old script after an update (heuristic caching).
    for path in ("/journal/", "/journal/static/js/charts.js", "/journal/static/css/app.css"):
        assert client.get(path).headers.get("cache-control") == "no-cache", path


def test_dashboard_page_moved_to_home(client):
    r = client.get("/journal/dashboard", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/home"


def test_edit_and_delete_execution(client):
    t = create(client)
    leg = legs_by_strike(t)[535]
    exec_id = leg["executions"][0]["id"]
    assert client.patch(f"/api/journal/executions/{exec_id}", json={"price": 1.5}).status_code == 200
    v = data(client.get(f"/api/journal/trades/{t['id']}"))
    assert legs_by_strike(v)[535]["avg_cost"] == 1.5
    assert client.patch("/api/journal/executions/9999", json={"price": 1}).status_code == 404
    assert client.patch(f"/api/journal/executions/{exec_id}", json={"qty": 0}).status_code == 422
    assert client.delete(f"/api/journal/executions/{exec_id}").status_code == 200
    v = data(client.get(f"/api/journal/trades/{t['id']}"))
    assert list(legs_by_strike(v)) == [540.0]
    assert client.delete(f"/api/journal/executions/{exec_id}").status_code == 404


def test_delete_trade(client):
    t = create(client)
    assert data(client.delete(f"/api/journal/trades/{t['id']}")) == {"deleted": t["id"]}
    assert client.get(f"/api/journal/trades/{t['id']}").status_code == 404
    assert client.delete(f"/api/journal/trades/{t['id']}").status_code == 404


def test_not_found(client):
    resp = client.get("/api/journal/trades/99")
    assert resp.status_code == 404
    assert resp.json() == {"ok": False, "data": None, "error": "trade 99 not found"}


def test_event_and_mark_on_missing_trade(client):
    ev = {"event": "close", "executed_at": "2026-11-10", "fills": [{"leg_id": 1, "qty": 1, "price": 1}]}
    assert client.post("/api/journal/trades/99/events", json=ev).status_code == 404
    assert client.post("/api/journal/trades/99/marks",
                       json={"marked_at": "2026-11-10", "position_value": 1}).status_code == 404
    assert client.patch("/api/journal/trades/99", json={"notes": "x"}).status_code == 404


def test_event_with_foreign_leg_is_404(client):
    a, b = create(client), create(client)
    ev = {"event": "close", "executed_at": "2026-11-10",
          "fills": [{"leg_id": b["legs"][0]["id"], "qty": 1, "price": 1}]}
    assert client.post(f"/api/journal/trades/{a['id']}/events", json=ev).status_code == 404


@pytest.mark.parametrize("change,needle", [
    ({"fills": [{"leg": {"kind": "put", "expiry": "2026-12-18"}, "qty": 1, "price": 1}]}, "strike"),
    ({"fills": [{"leg": opt("put", 540), "qty": 0, "price": 1}]}, "zero"),
    ({"strategy": "yolo"}, "unknown strategy"),
    ({"underlying": "1BAD"}, "underlying"),
    ({"fills": [{"leg_id": 3, "qty": 1, "price": 1}]}, "describe their leg"),
    ({"fills": [{"leg": {"kind": "stock", "strike": 5}, "qty": 1, "price": 1}]}, "stock legs"),
    ({"confidence": 9}, "confidence"),
])
def test_validation_errors(client, change, needle):
    resp = client.post("/api/journal/trades", json=put_spread(**change))
    assert resp.status_code == 422
    body = resp.json()
    assert body["ok"] is False and needle in body["error"]


def test_screenshots(client, settings):
    t = create(client)
    url = f"/api/journal/trades/{t['id']}/screenshots"
    shot = data(client.post(url, files={"file": ("a.png", PNG, "image/png")}, data={"caption": "entry"}))
    assert (settings.screenshot_dir / shot["filename"]).exists()
    v = data(client.get(f"/api/journal/trades/{t['id']}"))
    assert v["screenshots"][0]["caption"] == "entry"
    assert client.get(f"/journal/screenshots/{shot['filename']}").status_code == 200
    bad = client.post(url, files={"file": ("a.png", b"hello world", "image/png")})
    assert bad.status_code == 415 and bad.json()["ok"] is False
    big = client.post(url, files={"file": ("a.png", PNG + b"\x00" * 2000, "image/png")})
    assert big.status_code == 413
    assert client.post("/api/journal/trades/99/screenshots", files={"file": ("a.png", PNG)}).status_code == 404
    assert client.delete(f"/api/journal/screenshots/{shot['id']}").status_code == 200
    assert not (settings.screenshot_dir / shot["filename"]).exists()
    assert client.delete(f"/api/journal/screenshots/{shot['id']}").status_code == 404


def test_delete_trade_removes_screenshot_files(client, settings):
    t = create(client)
    shot = data(client.post(f"/api/journal/trades/{t['id']}/screenshots", files={"file": ("a.png", PNG)}))
    client.delete(f"/api/journal/trades/{t['id']}")
    assert not (settings.screenshot_dir / shot["filename"]).exists()


def test_export_csv_escapes_formulas(client):
    create(client, thesis="=HYPERLINK(\"x\")", tags=[{"kind": "tag", "value": "a"}])
    resp = client.get("/api/journal/export.csv")
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/csv")
    text = resp.text
    assert "'=HYPERLINK" in text and "tag:a" in text
    assert text.splitlines()[0].startswith("id,underlying,strategy")


def test_export_json(client):
    create(client)
    rows = data(client.get("/api/journal/export.json"))
    assert rows[0]["legs"][0]["executions"]


def test_stats(client):
    def trade(close_prices, mistake=None, when="2026-11-10"):
        tags = [{"kind": "mistake", "value": mistake}] if mistake else []
        t = create(client, tags=tags)
        return data(close_all(client, t, close_prices, when))

    win = trade({540: 0.5, 535: 0.1}, when="2026-11-05")          # +80 - 2.6
    loss = trade({540: 5.0, 535: 1.0}, "early entry", "2026-11-06")  # -280 - 2.6
    win2 = trade({540: 1.0, 535: 0.4}, when="2026-11-07")          # +60 - 2.6
    create(client)  # open trade
    s = data(client.get("/api/journal/stats"))
    h = s["headline"]
    assert h["trades"] == 3 and h["open_trades"] == 1
    assert h["win_rate"] == pytest.approx(66.7)
    pnls = [win["realized_pnl"], loss["realized_pnl"], win2["realized_pnl"]]
    assert h["total_pnl"] == pytest.approx(sum(pnls))
    assert h["profit_factor"] == pytest.approx(round((pnls[0] + pnls[2]) / -pnls[1], 2))
    assert [p["equity"] for p in s["equity"]] == pytest.approx(
        [pnls[0], pnls[0] + pnls[1], sum(pnls)])
    assert s["equity"][1]["drawdown"] == pytest.approx(pnls[1])
    mistakes = {r["key"]: r for r in s["by_mistake"]}
    assert mistakes["early entry"]["pnl"] == pytest.approx(pnls[1])
    assert mistakes["(none)"]["trades"] == 2
    assert s["by_month"][0]["key"] == "2026-11"
    assert s["by_dte"][0]["key"] == "46-90"
    assert s["open_risk"] == [{"expiry": "2026-12-18", "risk": 380.0, "unlimited": 0}]


def test_stats_empty(client):
    s = data(client.get("/api/journal/stats"))
    assert s["headline"]["trades"] == 0 and s["headline"]["win_rate"] is None
    assert s["equity"] == []
