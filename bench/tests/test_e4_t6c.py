#!/usr/bin/env python3
"""E4-a regression test — the T6-compact per-request curve (bench/extract-t6c.py).

Pins on synthetic runs:
  - the per-request curve: one row per trace request with
    fresh/cacheRead/cacheWrite/output/contextHash + costWeighted
    (fresh + 0.1 × cacheRead, the bench accounting convention);
  - the R3 boundary rule: a `microcompacted` event between two requests
    IS the boundary; the contextHash must CHANGE across it — a compacted
    boundary whose hash is unchanged is a boundary_mismatch (a finding,
    never silently accepted);
  - the turn mapping: requests land in the bucket of the `user_input`
    event they follow (bucket = the 6-turn windows, wall_N per bucket);
  - the E4-e guards: a run without meta.json is REFUSED, a repeated run
    name within the round is REFUSED, an empty run is REFUSED — the
    extractor never silently merges or invents evidence.

Run: python3 -m unittest tests/test_e4_t6c.py   (from bench/)
"""
import importlib.util, json, os, sys, tempfile, unittest

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BENCH)


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BENCH, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


extract_t6c = _load("extract-t6c.py", "extract_t6c")


def _req(idx, ts, ctx_hash, fresh=10, cache=20, cw=None, out=5, tools=()):
    """A trace sidecar request record (the v3 ledger shape: the canonical
    block holds the usage quartet; contextHash rides alongside)."""
    return {
        "schemaVersion": 3,
        "kind": "request",
        "requestId": f"r{idx}",
        "runId": "run-1",
        "requestIndex": idx,
        "retryAttempt": 0,
        "provider": "openai-compat",
        "model": "m",
        "adapterVersion": "0.2.1",
        "systemPromptHash": "s" * 64,
        "toolSchemaHash": "t" * 64,
        "contextHash": ctx_hash,
        "contextManifest": [],
        "segmentHashes": [],
        "stablePrefixFingerprint": "p" * 64,
        "freshInput": fresh,
        "cacheRead": cache,
        "cacheWrite": cw,
        "output": out,
        "canonical": {
            "input": fresh, "cacheRead": cache, "cacheWrite": cw,
            "output": out, "reasoning": None, "costUsd": 0,
            "pricingTableId": "builtin", "pricingTableVersion": 1,
        },
        "rent": [{"surface": "envelope", "chars": 38, "estTokens": 10}],
        "latencyMs": 1, "ttftMs": 0,
        "toolCalls": list(tools),
        "outcome": "ok",
        "ts": ts,
    }


def _run_dir(root, name, requests, events, meta=True, verify="pass", walls=(1,)):
    """A synthetic run: repo-less, with the pieces the extractor reads."""
    d = os.path.join(root, name)
    os.makedirs(os.path.join(d, "kiso-home", "sessions", "traces"), exist_ok=True)
    sidecar = os.path.join(d, "kiso-home", "sessions", "traces", "sid.jsonl")
    with open(sidecar, "w") as f:
        for r in requests:
            f.write(json.dumps(r) + "\n")
    if events:
        evlog = os.path.join(d, "kiso-home", "sessions", "sess.jsonl")
        with open(evlog, "w") as f:
            for e in events:
                f.write(json.dumps({"event": e}) + "\n")
    if meta:
        with open(os.path.join(d, "meta.json"), "w") as f:
            f.write(json.dumps({"tool": "kiso", "task": "T6C", "seq": "1",
                                "round": "t", "model": "m", "kisoVersion": "0.2.1",
                                "commit": "abc1234"}) + "\n")
    with open(os.path.join(d, "verify"), "w") as f:
        f.write(verify + "\n")
    for i, w in enumerate(walls, start=1):
        with open(os.path.join(d, f"wall_{i}"), "w") as f:
            f.write(str(w) + "\n")
    return d


class T6cExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.round = os.path.join(self.tmp, "runs", "e4t")

    def test_per_request_curve_rows(self):
        """One row per request: the usage quartet + contextHash + costWeighted."""
        reqs = [_req(0, 100, "h1", fresh=10, cache=20, cw=5),
                _req(1, 200, "h2", fresh=30, cache=0, cw=None)]
        _run_dir(self.round, "kiso-T6C-1", reqs, None)
        rows = extract_t6c.extract_run(os.path.join(self.round, "kiso-T6C-1"))
        self.assertEqual(len(rows["requests"]), 2)
        r0, r1 = rows["requests"]
        self.assertEqual(r0["fresh"], 10); self.assertEqual(r0["cacheRead"], 20)
        self.assertEqual(r0["cacheWrite"], 5); self.assertEqual(r0["output"], 5)
        self.assertEqual(r0["contextHash"], "h1")
        self.assertEqual(r0["costWeighted"], 12.0)   # 10 + 0.1×20
        self.assertEqual(r1["cacheWrite"], None)
        self.assertEqual(r1["costWeighted"], 30.0)

    def test_boundary_from_microcompacted_event(self):
        """The R3 rule: a microcompacted event between two requests makes the
        later request a boundary; the hash must change across it."""
        reqs = [_req(0, 100, "h1"), _req(1, 300, "h2")]
        events = [{"type": "user_input", "ts": 50},
                  {"type": "microcompacted", "beforeSeq": 5, "ts": 250}]
        _run_dir(self.round, "kiso-T6C-1", reqs, events)
        rows = extract_t6c.extract_run(os.path.join(self.round, "kiso-T6C-1"))
        self.assertFalse(rows["requests"][0]["boundary"])
        self.assertTrue(rows["requests"][1]["boundary"])
        self.assertEqual(rows["mismatches"], [])

    def test_boundary_mismatch_is_a_finding(self):
        """Compacted but the hash unchanged → boundary_mismatch, listed, never silent."""
        reqs = [_req(0, 100, "h1"), _req(1, 300, "h1")]
        events = [{"type": "user_input", "ts": 50},
                  {"type": "microcompacted", "beforeSeq": 5, "ts": 250}]
        _run_dir(self.round, "kiso-T6C-1", reqs, events)
        rows = extract_t6c.extract_run(os.path.join(self.round, "kiso-T6C-1"))
        self.assertTrue(rows["requests"][1]["boundary"])
        self.assertTrue(rows["requests"][1]["boundaryMismatch"])
        self.assertEqual(len(rows["mismatches"]), 1)
        self.assertEqual(rows["mismatches"][0]["requestIndex"], 1)

    def test_turn_mapping_buckets(self):
        """user_input events cut turns; a request lands in the bucket of the
        input it follows (6-turn windows, wall_N per bucket)."""
        reqs = [_req(0, 100, "h1"), _req(1, 150, "h2"), _req(2, 200, "h3")]
        events = [{"type": "user_input", "ts": 50},     # turn 1
                  {"type": "usage", "ts": 120},         # noise after r0
                  {"type": "user_input", "ts": 180}]    # turn 2
        _run_dir(self.round, "kiso-T6C-1", reqs, events, walls=(60, 70))
        rows = extract_t6c.extract_run(os.path.join(self.round, "kiso-T6C-1"))
        self.assertEqual(rows["requests"][0]["turn"], 1)
        self.assertEqual(rows["requests"][1]["turn"], 1)
        self.assertEqual(rows["requests"][2]["turn"], 2)
        self.assertEqual(rows["walls"], [60, 70])

    def test_guards_refuse_unlabeled_runs(self):
        """E4-e: a run without meta.json is refused, loudly."""
        d = _run_dir(self.round, "kiso-T6C-1", [_req(0, 100, "h1")], None, meta=False)
        with self.assertRaises(ValueError):
            extract_t6c.extract_run(d)

    def test_guards_refuse_empty_runs(self):
        """E4-e: an empty run (no trace) is refused, loudly."""
        d = _run_dir(self.round, "kiso-T6C-1", [], None)
        with self.assertRaises(ValueError):
            extract_t6c.extract_run(d)

    def test_round_scan_rejects_repeated_seq(self):
        """E4-e: two runs with the same parsed identity in one round are refused."""
        _run_dir(self.round, "kiso-T6C-1", [_req(0, 100, "h1")], None)
        _run_dir(self.round, "kiso-T6C-1b", [_req(0, 100, "h1")], None,
                 meta=False)  # parse still yields T6C-1; the scanner must catch it
        with self.assertRaises(ValueError):
            extract_t6c.scan_round(self.round)

    def test_round_scan_yields_rows(self):
        """The round scan maps each run to its curve + verify + meta."""
        _run_dir(self.round, "kiso-T6C-1", [_req(0, 100, "h1")], None)
        rows = extract_t6c.scan_round(self.round)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["run"], "1")
        self.assertEqual(rows[0]["verify"], "pass")
        self.assertEqual(rows[0]["meta"]["commit"], "abc1234")


if __name__ == "__main__":
    unittest.main()

    def test_envelope_ts_shape(self):
        """Real session logs carry ts on the ENVELOPE ({runId, ts, event}),
        not inside the event dict — the turn cuts and boundary detection
        must read it from either place (the 2026-08-13 real-run hole)."""
        reqs = [_req(0, 100, "h1"), _req(1, 300, "h2")]
        evlog = os.path.join(self.round, "kiso-T6C-1", "kiso-home", "sessions")
        os.makedirs(evlog, exist_ok=True)
        with open(os.path.join(evlog, "sess.jsonl"), "w") as f:
            f.write(json.dumps({"runId": "r1", "ts": 50,
                                "event": {"type": "user_input"}}) + "\n")
            f.write(json.dumps({"runId": "r1", "ts": 250,
                                "event": {"type": "microcompacted", "beforeSeq": 5}}) + "\n")
        _run_dir(self.round, "kiso-T6C-1", reqs, None)
        rows = extract_t6c.extract_run(os.path.join(self.round, "kiso-T6C-1"))
        self.assertEqual(rows["requests"][0]["turn"], 1)
        self.assertTrue(rows["requests"][1]["boundary"])
        self.assertEqual(rows["mismatches"], [])
