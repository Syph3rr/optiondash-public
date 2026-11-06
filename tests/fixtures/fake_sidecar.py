"""Fake market data sidecar for Rust supervision tests.

Usage: fake_sidecar.py MODE
  echo      answer every request; op "fail" -> error, op "missing" -> not_found
  hang      read requests, never answer
  crash:N   answer like echo, but exit abruptly on the Nth request of this process
  reverse   hold requests until two arrived, then answer them in reverse order
  slow      like echo, but op "slow" answers after 0.6 s
  die       log an ImportError-like line to stderr and exit 5 at once
  badstderr write a non-UTF-8 stderr line, then "tail line", then exit 4 at once
  garbage   print a junk line (and a line without a usable id) before each answer
  canned    argv[2] is a JSON object op -> {"data": ..., "echo": bool} or
            {"error": str, "code"?: str}; "echo" adds the request args as "seen_args"
            to the data. Ops not listed answer like echo.
"""
import json
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "echo"
crash_at = int(mode.split(":")[1]) if mode.startswith("crash:") else None


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if mode == "die":
    print("ImportError: no module named foo", file=sys.stderr, flush=True)
    sys.exit(5)
if mode == "badstderr":
    sys.stderr.buffer.write(bytes([0x63, 0xE9]) + b" not utf-8" + bytes([10]))
    sys.stderr.buffer.write(b"tail line" + bytes([10]))
    sys.stderr.buffer.flush()
    sys.exit(4)

canned = json.loads(sys.argv[2]) if mode == "canned" else {}
held = []
count = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    count += 1
    print("fake sidecar got request", count, file=sys.stderr, flush=True)
    if mode == "hang":
        continue
    if crash_at is not None and count >= crash_at:
        sys.stdout.flush()
        sys.exit(3)
    req = json.loads(line)
    if mode == "garbage":
        sys.stdout.write("this is not json\n")
        sys.stdout.write('{"id": null, "ok": true}\n')
        sys.stdout.flush()
    op = req.get("op")
    if mode == "reverse":
        held.append(req)
        if len(held) == 2:
            for r in reversed(held):
                send({"id": r["id"], "ok": True, "data": {"op": r.get("op"), "args": r.get("args")}})
            held.clear()
        continue
    if mode == "slow" and op == "slow":
        time.sleep(0.6)
    if op in canned:
        entry = canned[op]
        if "error" in entry:
            reply = {"id": req["id"], "ok": False, "error": entry["error"]}
            if "code" in entry:
                reply["code"] = entry["code"]
            send(reply)
        else:
            data = entry.get("data")
            if entry.get("echo"):
                data = {**data, "seen_args": req.get("args")}
            send({"id": req["id"], "ok": True, "data": data})
    elif op == "fail":
        send({"id": req["id"], "ok": False, "error": "boom"})
    elif op == "missing":
        send({"id": req["id"], "ok": False, "error": "no such thing", "code": "not_found"})
    else:
        send({"id": req["id"], "ok": True, "data": {"op": op, "args": req.get("args")}})
