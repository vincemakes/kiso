#!/usr/bin/env python3
"""RD-1 stream-cut proxy (scenario C7) — stdlib only.

A local forwarding proxy for an OpenAI-compatible endpoint. While
armed, the FIRST streamed response is cut abruptly after --cut-bytes
of body, exactly once (the state file records the firing); every
other request passes through untouched. Agent-neutral at the protocol
level: any agent that accepts a base-url override can sit behind it.

usage: proxy.py --port N --upstream host[:port] [--scheme https]
                --state /path/state.json [--cut-bytes 2048]
"""
import argparse
import http.client
import http.server
import json
import os
import ssl
import threading

ARGS = None
LOCK = threading.Lock()


def state():
    try:
        return json.load(open(ARGS.state))
    except OSError:
        return {"armed": True, "fired": False}


def save_state(s):
    with open(ARGS.state, "w") as f:
        json.dump(s, f)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _forward(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        if ARGS.scheme == "https":
            conn = http.client.HTTPSConnection(ARGS.upstream, context=ssl.create_default_context(), timeout=300)
        else:
            conn = http.client.HTTPConnection(ARGS.upstream, timeout=300)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection")}
        headers["Host"] = ARGS.upstream.split(":")[0]
        if body:
            headers["Content-Length"] = str(len(body))
        conn.request(self.command, self.path, body=body if body else None, headers=headers)
        resp = conn.getresponse()

        with LOCK:
            s = state()
            cut_this = s.get("armed") and not s.get("fired")

        self.send_response(resp.status)
        hop = {"connection", "keep-alive", "transfer-encoding", "content-length"}
        for k, v in resp.getheaders():
            if k.lower() not in hop:
                self.send_header(k, v)
        streamed = 0
        chunks = []
        # buffer nothing: stream as it arrives, chunked
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            while True:
                chunk = resp.read(256)
                if not chunk:
                    break
                streamed += len(chunk)
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
                if cut_this and streamed >= ARGS.cut_bytes:
                    with LOCK:
                        s = state()
                        s["fired"] = True
                        save_state(s)
                    # abrupt: no terminating chunk, hard close.
                    try:
                        self.connection.shutdown(2)
                    except OSError:
                        pass
                    self.connection.close()
                    return
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except BrokenPipeError:
            pass
        finally:
            conn.close()

    def do_POST(self):
        self._forward()

    def do_GET(self):
        self._forward()


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--upstream", required=True)
    ap.add_argument("--scheme", default="https", choices=["http", "https"])
    ap.add_argument("--state", required=True)
    ap.add_argument("--cut-bytes", type=int, default=2048)
    ARGS = ap.parse_args()
    if not os.path.exists(ARGS.state):
        save_state({"armed": True, "fired": False})
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"[rd1-proxy] listening on 127.0.0.1:{ARGS.port} -> {ARGS.scheme}://{ARGS.upstream} (cut at {ARGS.cut_bytes}B once)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
