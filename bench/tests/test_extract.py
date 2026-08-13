#!/usr/bin/env python3
"""Regression test for the bench extraction accounting (0.1.23 fresh-mystery
round; E2 1.3.0 — the canonical switch, T7). The README tables'
fresh/total/cost-wtd columns must mean the same thing per tool, or the
comparison silently double-counts:
  - kiso (1.3.0+): the TRACE SIDECAR — the canonical block's input is
    FRESH-ONLY on both routes (the pinned sentence); a v1 sidecar's
    freshInput IS the guard's route-derived fresh; an untraced session
    falls back to the session-log raw (fresh = inputTokens − cache_read,
    the legacy openai-compat derivation).
  - pi and claude report fresh-only input: fresh = input, total = input +
    cache_read.
  - cost_weighted = fresh + 0.1 × cache_read (DeepSeek cache-hit price
    ratio).
All rows carry the uniform canonical shape: input = fresh, total = fresh +
cache_read (the v8-and-older kiso tables kept the openai-compat raw shape
— identical numbers on healthy data; the switch fixes the >100% disease
where the old fresh went NEGATIVE). Pinned on synthetic records so a
future edit cannot regress the labeling (the exact bug that produced the
"fresh ≈ system prompt size" phantom anomaly in the 0.1.22 bench).

Run: python3 -m unittest tests/test_extract.py   (from bench/)
"""
import importlib.util, json, os, sys, tempfile, unittest

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BENCH)
import extract

def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BENCH, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

extract_t5 = _load("extract-t5.py", "extract_t5")
extract_t6 = _load("extract-t6.py", "extract_t6")

def _sidecar_ledger(d, sid, requests):
    """Write a trace sidecar (header + requests + run_end) under the
    run's kiso-home; the session log of the SAME sid stays absent —
    the dedup must not double-count it when it exists either."""
    os.makedirs(f"{d}/kiso-home/sessions/traces")
    with open(f"{d}/kiso-home/sessions/traces/{sid}.jsonl", "w") as f:
        f.write(json.dumps({"schemaVersion": 2, "kind": "header", "sessionId": sid,
                            "kisoVersion": "1.3.0", "createdAt": 1}) + "\n")
        for r in requests:
            f.write(json.dumps(r) + "\n")
        f.write(json.dumps({"schemaVersion": 2, "kind": "run_end", "runId": "r1",
                            "ts": 2, "lastRequestIndex": len(requests) - 1}) + "\n")

class KisoAccountingTest(unittest.TestCase):
    def _session_dir(self, usage_events):
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        with open(f"{d}/kiso-home/sessions/s.jsonl", "w") as f:
            for u in usage_events:
                f.write(json.dumps({"event": {"type": "usage", **u}}) + "\n")
        return d

    def test_kiso_legacy_session_log_fresh_is_input_minus_cache(self):
        # NO sidecar: the session-log fallback — the legacy openai-compat
        # derivation, now reduced to the uniform row shape (input = fresh).
        d = self._session_dir([
            {"inputTokens": 1000, "cacheRead": 0, "outputTokens": 50},
            {"inputTokens": 2500, "cacheRead": 2200, "outputTokens": 80},
        ])
        m = extract.kiso(d)
        self.assertEqual(m["input"], 1300)          # the uniform shape: input = fresh
        self.assertEqual(m["cache_read"], 2200)
        self.assertEqual(m["fresh"], 1300)          # 1000 + (2500 − 2200)
        self.assertEqual(m["total"], 3500)          # 1300 + 2200
        self.assertEqual(m["requests"], 2)
        self.assertEqual(m["cost_weighted"], m["fresh"] + 0.1 * m["cache_read"])
        self.assertEqual(m["first_prompt"], 1000)   # first request true total: 1000 + 0
        # NOT 2000 — the v8-and-older first_prompt counted inputTokens +
        # cacheRead with the cache hit twice (raw already includes it).

    def test_kiso_v2_sidecar_reads_the_canonical_block(self):
        # The df2 fixture: canonical fresh 58 + cache 1920 (raw total 1978).
        # The session log for the same sid exists — the dedup must NOT
        # also read it (no double counting).
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        with open(f"{d}/kiso-home/sessions/s.jsonl", "w") as f:
            f.write(json.dumps({"event": {"type": "usage", "inputTokens": 1978,
                                          "cacheRead": 1920, "outputTokens": 111}}) + "\n")
        _sidecar_ledger(d, "s", [{
            "schemaVersion": 2, "kind": "request", "requestId": "r1", "runId": "r1",
            "requestIndex": 0, "retryAttempt": 0, "provider": "openai-compat",
            "model": "deepseek-chat", "adapterVersion": "1.3.0",
            "systemPromptHash": "a" * 64, "toolSchemaHash": "b" * 64,
            "contextHash": "c" * 64, "contextManifest": [], "segmentHashes": [],
            "stablePrefixFingerprint": "d" * 64, "freshInput": 58, "cacheRead": 1920,
            "cacheWrite": None, "output": 111,
            "canonical": {"input": 58, "cacheRead": 1920, "cacheWrite": None,
                          "output": 111, "reasoning": None, "costUsd": 0.00025,
                          "pricingTableVersion": 1},
            "latencyMs": 1, "ttftMs": 1, "toolCalls": [], "outcome": "ok", "ts": 1}])
        m = extract.kiso(d)
        self.assertEqual(m["fresh"], 58)            # canonical fresh, route-agnostic
        self.assertEqual(m["cache_read"], 1920)
        self.assertEqual(m["total"], 1978)          # 58 + 1920
        self.assertEqual(m["requests"], 1)          # exactly one — the dedup held
        self.assertEqual(m["cost_weighted"], 58 + 0.1 * 1920)
        self.assertEqual(m["first_prompt"], 1978)   # first request true total

    def test_kiso_v1_sidecar_falls_back_to_the_guard_fresh(self):
        # A pre-1.3.0 sidecar: no canonical block — freshInput IS the
        # guard's route-derived fresh. The disease fixture (fresh 41 +
        # cache 12410): the OLD session-log derivation would have read
        # fresh = 41 − 12410 = −12369 (negative cost) — the fallback is
        # the fix, read as defaults, never a crash (R1d-1).
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        _sidecar_ledger(d, "s", [{
            "schemaVersion": 1, "kind": "request", "requestId": "r1", "runId": "r1",
            "requestIndex": 0, "retryAttempt": 0, "provider": "anthropic",
            "model": "deepseek-chat", "adapterVersion": "1.2.0",
            "systemPromptHash": "a" * 64, "toolSchemaHash": "b" * 64,
            "contextHash": "c" * 64, "contextManifest": [], "segmentHashes": [],
            "stablePrefixFingerprint": "d" * 64, "freshInput": 41, "cacheRead": 12410,
            "cacheWrite": None, "output": 320,
            "latencyMs": 1, "ttftMs": 1, "toolCalls": [], "outcome": "ok", "ts": 1}])
        m = extract.kiso(d)
        self.assertEqual(m["fresh"], 41)            # the guard's fresh, never negative
        self.assertEqual(m["cache_read"], 12410)
        self.assertEqual(m["total"], 12451)
        self.assertEqual(m["cost_weighted"], 41 + 0.1 * 12410)

    def test_kiso_mixed_run_traced_plus_untraced_sessions(self):
        # One traced session (sidecar canonical) + one untraced session
        # (session-log legacy) in the SAME run: each line is reduced once,
        # at its own convention, into the one uniform row.
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        with open(f"{d}/kiso-home/sessions/legacy.jsonl", "w") as f:
            f.write(json.dumps({"event": {"type": "usage", "inputTokens": 5000,
                                          "cacheRead": 4600, "outputTokens": 60}}) + "\n")
        _sidecar_ledger(d, "traced", [{
            "schemaVersion": 2, "kind": "request", "requestId": "r1", "runId": "r1",
            "requestIndex": 0, "retryAttempt": 0, "provider": "openai-compat",
            "model": "deepseek-chat", "adapterVersion": "1.3.0",
            "systemPromptHash": "a" * 64, "toolSchemaHash": "b" * 64,
            "contextHash": "c" * 64, "contextManifest": [], "segmentHashes": [],
            "stablePrefixFingerprint": "d" * 64, "freshInput": 100, "cacheRead": 900,
            "cacheWrite": None, "output": 30,
            "canonical": {"input": 100, "cacheRead": 900, "cacheWrite": None,
                          "output": 30, "reasoning": None, "costUsd": 0.0001,
                          "pricingTableVersion": 1},
            "latencyMs": 1, "ttftMs": 1, "toolCalls": [], "outcome": "ok", "ts": 1}])
        m = extract.kiso(d)
        self.assertEqual(m["fresh"], 500)           # 400 (legacy) + 100 (canonical)
        self.assertEqual(m["cache_read"], 5500)     # 4600 + 900
        self.assertEqual(m["total"], 6000)
        self.assertEqual(m["requests"], 2)
        self.assertEqual(m["cost_weighted"], 500 + 0.1 * 5500)

    def test_pi_and_claude_fresh_is_input(self):
        # pi: message_end JSONL with usage.input (fresh-only).
        d = tempfile.mkdtemp()
        with open(f"{d}/stdout.log", "w") as f:
            f.write(json.dumps({"type": "message_end", "message": {"usage": {"input": 800, "cacheRead": 1500, "output": 90}}}) + "\n")
        m = extract.pi(d)
        self.assertEqual(m["fresh"], 800)           # pi input is fresh-only
        self.assertEqual(m["total"], 2300)
        self.assertEqual(m["cost_weighted"], 800 + 0.1 * 1500)

        # claude: single JSON with input_tokens (fresh-only) + cache_read.
        d2 = tempfile.mkdtemp()
        with open(f"{d2}/stdout.log", "w") as f:
            json.dump({"usage": {"input_tokens": 900, "cache_read_input_tokens": 5000, "output_tokens": 70}}, f)
        m2 = extract.claude(d2)
        self.assertEqual(m2["fresh"], 900)
        self.assertEqual(m2["total"], 5900)
        self.assertEqual(m2["cost_weighted"], 900 + 0.1 * 5000)

    def test_t6_buckets_split_at_inputs_in_log_order(self):
        # The durable log orders input-then-usage; the FIRST input must not
        # produce an empty leading bucket and the LAST turn's usage must not
        # vanish (the bug the input-first ordering would have caused).
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        for p in range(4):
            with open(f"{d}/wall_{p + 1}", "w") as f:
                f.write(str(10 + p))
        with open(f"{d}/kiso-home/sessions/s.jsonl", "w") as f:
            for i in range(24):
                f.write(json.dumps({"event": {"type": "user_input"}}) + "\n")
                f.write(json.dumps({"event": {"type": "usage",
                    "inputTokens": 1000 + i, "cacheRead": 0,
                    "outputTokens": 50}}) + "\n")
        b = extract_t6.kiso(d)
        self.assertEqual(len(b), 4)
        for p, bucket in enumerate(b):
            self.assertEqual(bucket["requests"], 6)
            self.assertEqual(bucket["cache_read"], 0)
            self.assertEqual(bucket["total"], 6000 + 36 * p + 15)  # i = 6p..6p+5
            self.assertEqual(bucket["fresh"], bucket["total"])
            self.assertEqual(bucket["wall"], 10 + p)

    def test_t6_bucket_boundary_carries_the_resume_cost(self):
        # The first turn of each kiso process re-reads the whole session:
        # turn 7 (bucket 2's first turn) is cache-heavy. The bucketing must
        # land that cost in bucket 2, not spread it.
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        for p in range(4):
            with open(f"{d}/wall_{p + 1}", "w") as f:
                f.write("1")
        with open(f"{d}/kiso-home/sessions/s.jsonl", "w") as f:
            for i in range(24):
                f.write(json.dumps({"event": {"type": "user_input"}}) + "\n")
                c = 4600 if i == 6 else 0          # the resume turn
                n = 5000 if i == 6 else 1000
                f.write(json.dumps({"event": {"type": "usage",
                    "inputTokens": n, "cacheRead": c,
                    "outputTokens": 80}}) + "\n")
        b = extract_t6.kiso(d)
        b1, b2 = b[0], b[1]
        self.assertEqual(b1["fresh"], 6000)        # 6 × 1000, no cache
        self.assertEqual(b2["fresh"], 5400)        # 400 + 5 × 1000
        self.assertEqual(b2["cache_read"], 4600)   # the resume prefix
        self.assertEqual(b2["total"], 10000)       # 5000 + 5 × 1000
        self.assertEqual(b2["cost_weighted"], 5400 + 460)
        self.assertEqual(b[2]["fresh"], 6000)      # buckets 3-4 untouched

    def test_t6_pi_buckets_sum_invocations_and_skip_missing_logs(self):
        # 24 -p invocations, one stdout-N.log each; per-bucket wall is the
        # runner's sum (here: synthetic files). Absent logs (a crashed turn)
        # are skipped, and the accounting stays fresh-only input.
        d = tempfile.mkdtemp()
        for i in range(1, 21):                     # turns 21-24 never ran
            with open(f"{d}/stdout-{i}.log", "w") as f:
                f.write(json.dumps({"type": "message_end", "message": {
                    "usage": {"input": 800, "cacheRead": 1500, "output": 90}}}) + "\n")
        for p in range(4):
            with open(f"{d}/wall_{p + 1}", "w") as f:
                f.write(str(3))
        b = extract_t6.pi(d)
        self.assertEqual(len(b), 4)
        for bucket in b[:3]:
            self.assertEqual(bucket["requests"], 6)
            self.assertEqual(bucket["fresh"], 4800)
            self.assertEqual(bucket["total"], 13800)
            self.assertEqual(bucket["cost_weighted"], 4800 + 900)  # 0.1 × 9000 cache
        self.assertEqual(b[3]["requests"], 2)      # only turns 19-20 ran
        self.assertEqual(b[3]["fresh"], 1600)
        self.assertEqual(b[3]["wall"], 3)

    def test_t5_kiso_uses_same_accounting(self):
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        with open(f"{d}/kiso-home/sessions/s.jsonl", "w") as f:
            f.write(json.dumps({"event": {"type": "usage", "inputTokens": 5000, "cacheRead": 4600, "outputTokens": 60}}) + "\n")
        m = extract_t5.kiso(d)
        self.assertEqual(m["fresh"], 400)
        self.assertEqual(m["total"], 5000)
        self.assertEqual(m["cost_weighted"], 400 + 0.1 * 4600)

if __name__ == "__main__":
    unittest.main()
