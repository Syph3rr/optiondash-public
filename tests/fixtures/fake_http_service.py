"""Stand-in for an HTTP module (like the journal) in the gateway's supervisor tests.

Modes (first argument):
  serve            serve on $FAKE_PORT until killed
  serve-then-exit  serve for a moment, print "bye" to stderr, exit with status 3
"""
import http.server
import os
import sys
import threading
import time


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"fake ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "serve"
    server = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ["FAKE_PORT"])), Handler)
    server.allow_reuse_address = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if mode == "serve-then-exit":
        time.sleep(1.0)
        server.shutdown()
        server.server_close()
        print("bye", file=sys.stderr, flush=True)
        sys.exit(3)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
