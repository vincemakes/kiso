#!/usr/bin/env python3
"""Regression test for the E1 trace report (slice 5, bench/trace-report.mjs).
The report reads the request-trace ledger (sessions/traces/<sid>.jsonl — the
E1 sidecar, format reference: docs/request-trace.md) plus the session event
log, and renders one row per request. This test pins the report's shape and
its two derivations on synthetic ledgers so a future edit cannot regress
them:
  - the R4b break depth (per-request, via the runtime's analyze.js dist):
    an unchanged cacheable prefix is no break; a changed middle segment
    breaks at that depth;
  - the est-vs-actual accounting: estTokens = sum of the manifest's
    segment estimates; actual = freshInput + cacheRead (openai-compat's
    input TOTAL); the estimate must never be silently relabeled.
Plus the integrity checks: every line validates against the runtime's
validateTraceLine (a misaligned segmentHashes list is a corrupt ledger
line, counted invalid and skipped), and seqRange pointers must stay within
the event log.

Run: python3 -m unittest tests/test_trace_report.py   (from bench/)
"""
import json, os, subprocess, tempfile, unittest

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(BENCH, "trace-report.mjs")

H1 = "11" * 32; H2 = "22" * 32; H3 = "33" * 32
H4 = "44" * 32; H5 = "55" * 32; H6 = "66" * 32


def _hash(seed):
    # a distinct, valid sha-256-hex-looking placeholder per seed
    return format(seed, "x").rjust(64, "0")


def _request(req_id, index, segs, hashes, usage, extra=None):
    rec = {
        "schemaVersion": 1, "kind": "request", "requestId": req_id,
        "runId": "run-1", "requestIndex": index, "retryAttempt": 0,
        "provider": "openai-compat", "model": "m", "adapterVersion": "1.2.0",
        "systemPromptHash": H1, "toolSchemaHash": H2, "contextHash": _hash(index),
        "contextManifest": segs, "segmentHashes": hashes,
        "stablePrefixFingerprint": _hash(index + 10),
        "freshInput": usage[0], "cacheRead": usage[1], "cacheWrite": usage[2],
        "output": usage[3], "latencyMs": usage[4], "ttftMs": usage[5],
        "toolCalls": usage[6], "outcome": "ok", "ts": 1753400000000 + index,
    }
    if extra:
        rec.update(extra)
    return rec


def _seg(role, seq_range, est, freshness):
    return {"role": role, "seqRange": seq_range, "estTokens": est, "freshness": freshness}


class TraceReportTest(unittest.TestCase):
    def _home(self, sid, ledger_lines, log_seqs=15, base=None):
        d = tempfile.mkdtemp() if base is None else base
        os.makedirs(f"{d}/sessions/traces", exist_ok=True)
        with open(f"{d}/sessions/{sid}.jsonl", "w") as f:
            for n in range(1, log_seqs + 1):
                f.write(json.dumps({"event": {"type": "usage", "seq": n, "inputTokens": n}}) + "\n")
        with open(f"{d}/sessions/traces/{sid}.jsonl", "w") as f:
            for line in ledger_lines:
                f.write(json.dumps(line) + "\n")
        return d

    def _run(self, home, sid=None):
        cmd = ["node", REPORT, "--home", home, "--json"]
        if sid is not None:
            cmd += ["--session", sid]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=BENCH)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def _fixture(self):
        """The standard 3-request fixture: r1 and r2 share a cacheable
        prefix (no break); r3's middle turn changed (break at depth 2)."""
        base = [
            _seg("system", None, 210, "cache_read"),
            _seg("tools", None, 88, "cache_read"),
            _seg("turn", [1, 12], 140, "cache_read"),
        ]
        segs1 = base + [_seg("current_turn", [13, 13], 41, "fresh")]
        segs2 = base + [_seg("current_turn", [14, 14], 45, "fresh")]
        segs3 = base[:2] + [_seg("turn", [1, 12], 140, "cache_read"),
                            _seg("current_turn", [15, 15], 50, "fresh")]
        r1 = _request("9f3a7c11-6b3e-4f2a-9d0e-1c2b3a4d5e6f", 0, segs1, [H1, H2, H3, H4],
                      [41, 12410, None, 320, 2841.5, 402, ["read_file"]])
        r2 = _request("9f3a7c11-6b3e-4f2a-9d0e-1c2b3a4d5e70", 1, segs2, [H1, H2, H3, H5],
                      [45, 12500, 500, 310, 2400, 380, []])
        r3 = _request("9f3a7c11-6b3e-4f2a-9d0e-1c2b3a4d5e71", 2, segs3, [H1, H2, H6, H5],
                      [1200, 9000, 2000, 400, 3100, 610, ["write_file", "read_file"]])
        header = {"schemaVersion": 1, "kind": "header", "sessionId": "t1",
                  "kisoVersion": "1.2.0", "createdAt": 1753400000000}
        run_end = {"schemaVersion": 1, "kind": "run_end", "runId": "run-1",
                   "ts": 1753400000003, "lastRequestIndex": 2}
        return [header, r1, r2, r3, run_end]

    def test_rows_breaks_and_totals(self):
        home = self._home("t1", self._fixture())
        [report] = self._run(home)
        self.assertEqual(report["sessionId"], "t1")
        self.assertEqual(report["kisoVersion"], "1.2.0")
        rows = report["rows"]
        self.assertEqual(len(rows), 3)

        # r1: the first request has no predecessor — break null
        r0 = rows[0]
        self.assertEqual(r0["index"], 0)
        self.assertEqual(r0["retryAttempt"], 0)
        self.assertEqual(r0["fresh"], 41)
        self.assertEqual(r0["cacheRead"], 12410)
        self.assertIsNone(r0["cacheWrite"])           # openai-compat honest null
        self.assertEqual(r0["output"], 320)
        self.assertEqual(r0["estTokens"], 479)        # 210 + 88 + 140 + 41
        self.assertEqual(r0["estVsActual"], 479 - 12451)
        self.assertEqual(r0["ttftMs"], 402)
        self.assertEqual(r0["latencyMs"], 2841.5)
        self.assertEqual(r0["toolCalls"], ["read_file"])
        self.assertIsNone(r0["breakDepth"])
        self.assertEqual(r0["outcome"], "ok")
        self.assertTrue(r0["seqRangeOk"])

        # r2: same cacheable prefix → no break, despite the current-turn change
        self.assertIsNone(rows[1]["breakDepth"])
        self.assertEqual(rows[1]["estTokens"], 483)
        self.assertEqual(rows[1]["estVsActual"], 483 - 12545)

        # r3: the middle turn's hash changed → break at depth 2
        self.assertEqual(rows[2]["breakDepth"], 2)
        self.assertEqual(rows[2]["cacheWrite"], 2000)
        self.assertEqual(rows[2]["toolCalls"], ["write_file", "read_file"])  # order preserved
        self.assertEqual(rows[2]["estVsActual"], 488 - 10200)

        totals = report["totals"]
        self.assertEqual(totals["requests"], 3)
        self.assertEqual(totals["fresh"], 1286)
        self.assertEqual(totals["cacheRead"], 33910)
        self.assertEqual(totals["cacheWrite"], 2500)
        self.assertEqual(totals["output"], 1030)
        self.assertEqual(totals["breaks"], 1)
        self.assertEqual(totals["avgLatencyMs"], (2841.5 + 2400 + 3100) / 3)
        self.assertEqual(report["eventLog"], {"lastSeq": 15, "count": 15})
        self.assertEqual(report["runEnds"], 1)
        self.assertEqual(report["crashes"], 0)
        self.assertEqual(report["invalid"], 0)

    def test_corrupt_lines_are_counted_invalid_and_skipped(self):
        # a non-JSON line and a misaligned segmentHashes list (the R4b
        # 1:1 gate) are corrupt ledger lines — invalid, never rows
        fixture = self._fixture()
        fixture.insert(3, "this is not json")
        bad = dict(fixture[2])
        bad["segmentHashes"] = bad["segmentHashes"][:3]  # 3 hashes vs 4 segments
        fixture[2] = bad                                    # corrupts r2 in place
        home = self._home("t1", fixture)
        [report] = self._run(home)
        self.assertEqual(len(report["rows"]), 2)         # r2 and r3 survive
        self.assertEqual(report["invalid"], 2)
        # r3 still sees r2 as its predecessor: break at depth 2 intact
        self.assertEqual(report["rows"][1]["breakDepth"], 2)

    def test_seqrange_beyond_the_event_log_flags_false(self):
        fixture = self._fixture()
        fixture[1]["contextManifest"][3]["seqRange"] = [13, 99]  # beyond lastSeq 15
        home = self._home("t1", fixture)
        [report] = self._run(home)
        self.assertFalse(report["rows"][0]["seqRangeOk"])
        self.assertTrue(report["rows"][1]["seqRangeOk"])

    def test_markdown_mode_renders_a_table(self):
        home = self._home("t1", self._fixture())
        r = subprocess.run(["node", REPORT, "--home", home, "--session", "t1"],
                           capture_output=True, text=True, cwd=BENCH)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("request trace", r.stdout)
        self.assertIn("est−actual", r.stdout)
        self.assertIn("| 0 | 0 | 41 | 12410 | – |", r.stdout)
        self.assertIn("1 cache-prefix breaks", r.stdout)

    def test_no_ledgers_exits_1(self):
        d = tempfile.mkdtemp()
        r = subprocess.run(["node", REPORT, "--home", d],
                           capture_output=True, text=True, cwd=BENCH)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no ledgers", r.stdout)

    def test_session_filter_selects_one(self):
        home = self._home("t1", self._fixture())
        self._home("t2", self._fixture(), base=home)  # same home, second session
        [one] = self._run(home, sid="t1")
        self.assertEqual(one["sessionId"], "t1")


if __name__ == "__main__":
    unittest.main()
