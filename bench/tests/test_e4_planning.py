#!/usr/bin/env python3
"""E4-b regression test — the planning eval (bench/extract-planning.py).

Pins on synthetic ON/OFF runs:
  - the per-task metrics: requests, cacheWrite (sum), rework
    (tool_execution_failed count), verified pass (per-task verify file),
    activation (ON arm: task_set calls per task, from toolCalls);
  - the arm sanity check via the rent ledger: an ON run's trace carries
    system:ext:task + tool:task_set lines, an OFF run's does not (the
    OFF arm shadows the built-in task extension with a name-only shell —
    E3's ledger is the arm detector, not a transcription);
  - the verdict rule: OFF passes the same tasks AND is cheaper on either
    metric → the rent is a reduction CANDIDATE (proposed for E5/E6, never
    a cut here); OFF fails where ON passes, or OFF reworks ≥ ON → the
    insurance holds.

Run: python3 -m unittest tests/test_e4_planning.py   (from bench/)
"""
import importlib.util, json, os, sys, tempfile, unittest

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BENCH)

extract_planning = _load = None


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BENCH, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


extract_planning = _load("extract-planning.py", "extract_planning")

TASK_RENT = [{"surface": "system:ext:task", "chars": 394, "estTokens": 99},
             {"surface": "tool:task_set", "chars": 551, "estTokens": 138}]


def _req(idx, ts, tools=(), task_line=True, cache_write=0):
    rent = list(TASK_RENT) if task_line else []
    rent.append({"surface": "envelope", "chars": 38, "estTokens": 10})
    return {
        "schemaVersion": 3, "kind": "request",
        "requestId": f"r{idx}", "runId": "run-1", "requestIndex": idx,
        "retryAttempt": 0, "provider": "openai-compat", "model": "m",
        "adapterVersion": "0.2.1",
        "systemPromptHash": "s" * 64, "toolSchemaHash": "t" * 64,
        "contextHash": "h" * 64, "contextManifest": [], "segmentHashes": [],
        "stablePrefixFingerprint": "p" * 64,
        "freshInput": 100, "cacheRead": 200, "cacheWrite": cache_write,
        "output": 50,
        "canonical": {"input": 100, "cacheRead": 200, "cacheWrite": cache_write,
                      "output": 50, "reasoning": None, "costUsd": 0,
                      "pricingTableId": "builtin", "pricingTableVersion": 1},
        "rent": rent, "latencyMs": 1, "ttftMs": 0,
        "toolCalls": list(tools), "outcome": "ok", "ts": ts,
    }


def _run_dir(root, name, reqs, fails=0, verifies=None, meta=True):
    d = os.path.join(root, name)
    os.makedirs(os.path.join(d, "kiso-home", "sessions", "traces"), exist_ok=True)
    with open(os.path.join(d, "kiso-home", "sessions", "traces", "sid.jsonl"), "w") as f:
        for r in reqs:
            f.write(json.dumps(r) + "\n")
    evlog = os.path.join(d, "kiso-home", "sessions", "sess.jsonl")
    with open(evlog, "w") as f:
        for i in range(fails):
            f.write(json.dumps({"event": {"type": "tool_execution_failed",
                                          "tool": "write_file", "ts": 10 + i}}) + "\n")
    if meta:
        with open(os.path.join(d, "meta.json"), "w") as f:
            f.write(json.dumps({"tool": "kiso", "task": "PLN", "seq": "1",
                                "round": "t", "model": "m", "kisoVersion": "0.2.1",
                                "commit": "abc1234", "arm": name.split("-")[2]}) + "\n")
    for task, v in (verifies or {"T2": "pass", "T3": "pass"}).items():
        with open(os.path.join(d, f"verify-{task}"), "w") as f:
            f.write(v + "\n")
    with open(os.path.join(d, "wall_seconds"), "w") as f:
        f.write("120\n")
    return d


class PlanningExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.round = os.path.join(self.tmp, "runs", "e4p")

    def test_per_task_metrics(self):
        d = _run_dir(self.round, "kiso-PLN-on-1",
                     [_req(0, 100, tools=["task_set", "read_file"], task_line=True, cache_write=7),
                      _req(1, 200, tools=["write_file"], task_line=True, cache_write=3)],
                     fails=1)
        m = extract_planning.extract_run(d)
        self.assertEqual(m["requests"], 2)
        self.assertEqual(m["cacheWrite"], 10)
        self.assertEqual(m["rework"], 1)
        self.assertEqual(m["verifiedPass"], 2)      # T2 + T3 both pass
        self.assertEqual(m["activation"], 1)        # one task_set call per task
        self.assertEqual(m["costWeighted"], 2 * (100 + 0.1 * 200))

    def test_rent_detects_the_arm(self):
        on = extract_planning.extract_run(_run_dir(
            self.round, "kiso-PLN-on-1", [_req(0, 100, task_line=True)]))
        off = extract_planning.extract_run(_run_dir(
            self.round, "kiso-PLN-off-1", [_req(0, 100, task_line=False)]))
        self.assertTrue(on["rentHasTask"])
        self.assertFalse(off["rentHasTask"])
        # E3's measured rent difference: the spec + the append, gone in OFF
        self.assertEqual(on["rentChars"] - off["rentChars"], 394 + 551)

    def test_activation_is_zero_off_arm(self):
        off = extract_planning.extract_run(_run_dir(
            self.round, "kiso-PLN-off-1",
            [_req(0, 100, tools=["read_file"], task_line=False)]))
        self.assertEqual(off["activation"], 0)

    def test_verified_fail_is_recorded(self):
        d = _run_dir(self.round, "kiso-PLN-off-1",
                     [_req(0, 100, task_line=False)],
                     verifies={"T2": "fail", "T3": "pass"})
        m = extract_planning.extract_run(d)
        self.assertEqual(m["verifiedPass"], 1)
        self.assertEqual(len(m["tasks"]), 2)

    def test_verdict_off_fail_is_insurance(self):
        """OFF fails where ON passes → the insurance holds."""
        on = {"verifiedPass": 2, "requests": 8, "cacheWrite": 20,
              "costWeighted": 900, "wall": 100, "rework": 0}
        off = {"verifiedPass": 1, "requests": 6, "cacheWrite": 10,
               "costWeighted": 500, "wall": 60, "rework": 0}
        v = extract_planning.verdict(on, off)
        self.assertEqual(v["class"], "insurance-holds")

    def test_verdict_off_cheaper_is_candidate(self):
        """OFF passes the same tasks AND is cheaper → a reduction CANDIDATE
        for E5/E6 — never a cut in E4 (measurement-only)."""
        on = {"verifiedPass": 2, "requests": 8, "cacheWrite": 20,
              "costWeighted": 900, "wall": 100, "rework": 2}
        off = {"verifiedPass": 2, "requests": 6, "cacheWrite": 10,
               "costWeighted": 500, "wall": 60, "rework": 1}
        v = extract_planning.verdict(on, off)
        self.assertEqual(v["class"], "reduction-candidate")

    def test_verdict_off_fails_everything_is_dead_weight(self):
        on = {"verifiedPass": 2, "requests": 8, "cacheWrite": 20,
              "costWeighted": 900, "wall": 100, "rework": 0}
        off = {"verifiedPass": 0, "requests": 6, "cacheWrite": 10,
               "costWeighted": 500, "wall": 60, "rework": 0}
        v = extract_planning.verdict(on, off)
        self.assertEqual(v["class"], "dead-weight")  # OFF cannot even pass


if __name__ == "__main__":
    unittest.main()
