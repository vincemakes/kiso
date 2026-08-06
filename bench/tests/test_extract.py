#!/usr/bin/env python3
"""Regression test for the bench extraction accounting (0.1.23 fresh-mystery
round). The README tables' fresh/total/cost-wtd columns must mean the same
thing per tool, or the comparison silently double-counts:
  - kiso's inputTokens INCLUDES the cache-hit prefix (DeepSeek convention):
    fresh = input − cache_read, total = input.
  - pi and claude report fresh-only input: fresh = input, total = input +
    cache_read.
  - cost_weighted = fresh + 0.1 × cache_read (DeepSeek cache-hit price
    ratio).
This test pins the semantics on synthetic records so a future edit cannot
regress the labeling (the exact bug that produced the "fresh ≈ system
prompt size" phantom anomaly in the 0.1.22 bench).

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

class KisoAccountingTest(unittest.TestCase):
    def _session_dir(self, usage_events):
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/kiso-home/sessions")
        with open(f"{d}/kiso-home/sessions/s.jsonl", "w") as f:
            for u in usage_events:
                f.write(json.dumps({"event": {"type": "usage", **u}}) + "\n")
        return d

    def test_kiso_fresh_is_input_minus_cache(self):
        d = self._session_dir([
            {"inputTokens": 1000, "cacheRead": 0, "outputTokens": 50},
            {"inputTokens": 2500, "cacheRead": 2200, "outputTokens": 80},
        ])
        m = extract.kiso(d)
        self.assertEqual(m["input"], 3500)          # total input incl. cached
        self.assertEqual(m["cache_read"], 2200)
        self.assertEqual(m["fresh"], 1300)          # 1000 + (2500 − 2200)
        self.assertEqual(m["total"], 3500)
        self.assertEqual(m["requests"], 2)
        self.assertEqual(m["cost_weighted"], m["fresh"] + 0.1 * m["cache_read"])

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
