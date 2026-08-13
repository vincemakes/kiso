#!/usr/bin/env python3
"""E4-d regression test — the machine band verdict (bench/band-compare.mjs).

Pins on synthetic extracted JSON the S1-1 / 0.1.46 verdict machinery:
  - the band is the PREVIOUS release's runs RANGE (min..max), never the mean;
  - this release's runs sit in-band / out-below (the cheap side) /
    out-above (the expensive side) per metric;
  - verify is a gate: ANY failed verify → blocker-class, even on the cheap side;
  - the S1-1 directional clause applied mechanically: out-below with all
    verifies passing = improvement-class ("proposed, for the reviewer" +
    a numbered finding); out-above or any verify failure = blocker-class;
  - the frontier point (the c-lens): verified passes vs costWeighted —
    the work-per-token north star's coordinates for this round.

The tool is node; this test drives it as a subprocess the way the report
will:  node band-compare.mjs <prev.json> <this.json>  → one JSON verdict.

Run: python3 -m unittest tests/test_e4_band.py   (from bench/)
"""
import json, os, subprocess, sys, tempfile, unittest

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.path.join(BENCH, "band-compare.mjs")


def _row(metric, verify="pass"):
    return {"tool": "kiso", "task": "T3", "run": "1",
            "costWeighted": metric, "wall": 100, "verify": verify,
            "verifiedPass": 1}


def _run(prev, this):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "prev.json"); t = os.path.join(d, "this.json")
    with open(p, "w") as f: json.dump(prev, f)
    with open(t, "w") as f: json.dump(this, f)
    r = subprocess.run(["node", NODE, p, t], capture_output=True, text=True,
                       cwd=BENCH)
    self_fail = getattr(unittest.TestCase(), "fail", None)
    return r


class BandCompareTest(unittest.TestCase):
    def _verdict(self, prev, this):
        r = _run(prev, this)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_in_band_flat(self):
        prev = [_row(100), _row(200)]
        this = [_row(150), _row(160)]
        v = self._verdict(prev, this)
        self.assertEqual(v["class"], "in-band")
        self.assertEqual(v["metrics"]["costWeighted"]["band"], [100, 200])
        self.assertEqual(v["metrics"]["costWeighted"]["positions"], ["in-band", "in-band"])

    def test_out_below_improvement_class(self):
        prev = [_row(100), _row(200)]
        this = [_row(80), _row(90)]
        v = self._verdict(prev, this)
        self.assertEqual(v["class"], "improvement-class")
        self.assertEqual(v["clause"]["directional"], "out-below + all verifies pass → improvement-class (proposed, for the reviewer)")

    def test_out_above_blocker_class(self):
        prev = [_row(100), _row(200)]
        this = [_row(250), _row(210)]
        v = self._verdict(prev, this)
        self.assertEqual(v["class"], "blocker-class")

    def test_verify_failure_is_blocker_even_cheap(self):
        prev = [_row(100), _row(200)]
        this = [_row(80, verify="pass"), _row(90, verify="fail")]
        v = self._verdict(prev, this)
        self.assertEqual(v["class"], "blocker-class")
        self.assertEqual(v["verify"]["allPass"], False)
        self.assertEqual(len(v["verify"]["failures"]), 1)

    def test_mixed_this_runs_take_worst_side(self):
        prev = [_row(100), _row(200)]
        this = [_row(80), _row(250)]   # one cheap, one expensive
        v = self._verdict(prev, this)
        self.assertEqual(v["class"], "blocker-class")

    def test_frontier_point(self):
        prev = [_row(100, verify="pass"), _row(200, verify="fail")]
        this = [_row(150, verify="pass"), _row(160, verify="pass")]
        v = self._verdict(prev, this)
        self.assertEqual(v["frontier"]["prev"], {"verifiedPass": 1, "costWeighted": 300})
        self.assertEqual(v["frontier"]["this"], {"verifiedPass": 2, "costWeighted": 310})

    def test_work_per_token(self):
        prev = [_row(100, verify="pass"), _row(100, verify="pass")]
        this = [_row(150, verify="pass"), _row(150, verify="pass")]
        v = self._verdict(prev, this)
        self.assertAlmostEqual(v["frontier"]["workPerToken"]["prev"], 2 / 200)
        self.assertAlmostEqual(v["frontier"]["workPerToken"]["this"], 2 / 300)

    def test_bad_input_fails_loudly(self):
        r = subprocess.run(["node", NODE, "/nonexistent.json", "/nope.json"],
                           capture_output=True, text=True, cwd=BENCH)
        self.assertNotEqual(r.returncode, 0)

    def test_extractor_snake_case_rows_accepted(self):
        # the extractors' actual shape (cost_weighted, no camelCase):
        # the report feeds extractor JSON straight in, no mapper.
        prev = [{"tool": "kiso", "task": "T3", "run": "1",
                 "cost_weighted": 100, "wall": 100, "verify": "pass"},
                {"tool": "kiso", "task": "T3", "run": "2",
                 "cost_weighted": 200, "wall": 200, "verify": "pass"}]
        this = [{"tool": "kiso", "task": "T3", "run": "1",
                 "cost_weighted": 150, "wall": 150, "verify": "pass"}]
        v = self._verdict(prev, this)
        self.assertEqual(v["class"], "in-band")
        self.assertEqual(v["metrics"]["costWeighted"]["band"], [100, 200])
        self.assertEqual(v["frontier"]["this"], {"verifiedPass": 1, "costWeighted": 150})


if __name__ == "__main__":
    unittest.main()
