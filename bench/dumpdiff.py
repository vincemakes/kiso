#!/usr/bin/env python3
"""dumpdiff.py — the fresh-mystery diagnostic: byte-diff consecutive request
bodies dumped by KISO_DUMP_REQUESTS=<dir> (req-<pid>-<n>.json), reporting
for each adjacent pair:
  - common-prefix length (bytes) and what fraction of the OLDER request it is
  - the JSON path of the FIRST divergence (the byte that broke the prefix)
  - whether the divergence is INSIDE the older request (a re-render bug — the
    D 区 violation: request N must be a byte prefix of request N+1) or only
    NEW tail bytes (healthy growth)

Usage: python3 dumpdiff.py <dir> [--path-only]
Prints one block per consecutive pair; a pair whose common prefix covers the
whole older request prints "PREFIX-OK" (that is the healthy case)."""

import json, os, sys

def path_of_divergence(a, b):
    """Walk a (older) and b (newer) side by side; return the JSON path of
    the first differing element (a==b structurally up to that point)."""
    def walk(pa, pb, path):
        if type(pa) != type(pb):
            return path + [f"<type {type(pa).__name__} vs {type(pb).__name__}>"]
        if isinstance(pa, dict):
            for k in pa:
                if k not in pb:
                    return path + [f"<key {k!r} missing in new>"]
                r = walk(pa[k], pb[k], path + [k])
                if r:
                    return r
            return None
        if isinstance(pa, list):
            for i, (x, y) in enumerate(zip(pa, pb)):
                r = walk(x, y, path + [i])
                if r:
                    return r
            if len(pa) != len(pb):
                return path + [f"<len {len(pa)} vs {len(pb)}>"]
            return None
        if pa != pb:
            return path + [f"<{pa!r} vs {pb!r}>"]
        return None
    return walk(a, b, [])

def main():
    d = sys.argv[1]
    only = "--path-only" in sys.argv
    files = sorted(
        (f for f in os.listdir(d) if f.startswith("req-") and f.endswith(".json")),
        key=lambda f: (int(f.split("-")[1]), int(f.split("-")[2].split(".")[0])),
    )
    if len(files) < 2:
        print(f"need >= 2 dumps, found {len(files)}")
        return 1
    bodies = [json.load(open(os.path.join(d, f))) for f in files]
    for i in range(len(bodies) - 1):
        a, b = bodies[i], bodies[i + 1]
        sa, sb = json.dumps(a, separators=(",", ":"), ensure_ascii=False), \
                 json.dumps(b, separators=(",", ":"), ensure_ascii=False)
        n = 0
        while n < min(len(sa), len(sb)) and sa[n] == sb[n]:
            n += 1
        print(f"--- {files[i]} -> {files[i+1]} ---")
        if n == len(sa):
            print("PREFIX-OK: request N is a full byte prefix of N+1 (healthy)")
            print(f"  new tail: {len(sb) - n} bytes")
            continue
        frac = n / len(sa) if sa else 1.0
        print(f"DIVERGES inside the older request at byte {n} ({frac:.1%} of the older body)")
        print(f"  older body: {len(sa)} bytes, newer: {len(sb)} bytes")
        if not only:
            path = path_of_divergence(a, b)
            print(f"  first divergent JSON path: {'.'.join(str(p) for p in (path or []))}")
            ctx = 60
            print(f"  older at that byte: {sa[max(0,n-ctx):n+ctx]!r}")
            print(f"  newer at that byte: {sb[max(0,n-ctx):n+ctx]!r}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
