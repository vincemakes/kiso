"""The release gate's machinery (0.48.0 on; kiso-doc kit-0480-ceremony):
the registered n as a machine gate (paired-compare --expect-pairs, INVALID
not FAIL), exact version matching in both runners, run-paired's pair list
and run-probe's first run id (the re-run paths), and the read-only void
audit (version, tool hash, effort, cache collapse, machine sleep;
identical arms are an instrument failure).

Run: python3 tests/test_ceremony_0480.py   (from bench/; npm run check runs it)
"""
import json, os, subprocess, sys, tempfile, time, unittest

B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_eval_0460 import fake_env, read  # noqa: E402


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def jsonl(path, records):
    write(path, "".join(json.dumps(r) + "\n" for r in records))


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, cwd=B, timeout=180, **kw)


def rows(n, task="T5", cost_rc=100.0, cost_ctl=100.0, verify="pass"):
    rc = [{"task": task, "run": str(i), "cost_weighted": cost_rc, "wall": 10, "verify": verify} for i in range(1, n + 1)]
    ctl = [{"task": task, "run": str(i), "cost_weighted": cost_ctl, "wall": 10, "verify": verify} for i in range(1, n + 1)]
    return rc, ctl


class ExpectPairs(unittest.TestCase):
    def compare(self, rc, ctl, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = os.path.join(tmp, "rc.json"), os.path.join(tmp, "ctl.json")
            write(a, json.dumps(rc)); write(b, json.dumps(ctl))
            r = run(["node", "paired-compare.mjs", a, b, "--causal=request", "--margins=bm1-a1", *extra])
            return r, (json.loads(r.stdout) if r.returncode == 0 else None)

    def test_fewer_usable_pairs_than_registered_is_invalid_never_a_pass(self):
        rc, ctl = rows(11)
        r, v = self.compare(rc, ctl, "--expect-pairs=12")
        self.assertEqual(v["verdict"], "INVALID")
        self.assertEqual((v["criteria"]["usablePairs"], v["criteria"]["expectedPairs"]), (11, 12))
        self.assertTrue(v["disposition"].startswith("INVALID — 11 usable pairs of 12 registered; no verdict"))

    def test_more_than_registered_is_invalid_too(self):
        rc, ctl = rows(13)
        self.assertEqual(self.compare(rc, ctl, "--expect-pairs=12")[1]["verdict"], "INVALID")

    def test_exactly_the_registered_n_judges_as_before(self):
        rc, ctl = rows(12)
        self.assertEqual(self.compare(rc, ctl, "--expect-pairs=12")[1]["verdict"], "PASS")
        rc, ctl = rows(12, cost_rc=150.0)
        self.assertEqual(self.compare(rc, ctl, "--expect-pairs=12")[1]["verdict"], "FAIL")

    def test_without_the_flag_the_old_behaviour_stands_and_a_bad_flag_is_refused(self):
        rc, ctl = rows(5)
        self.assertEqual(self.compare(rc, ctl)[1]["verdict"], "PASS")
        r, _ = self.compare(rc, ctl, "--expect-pairs=zero")
        self.assertEqual(r.returncode, 1)


def leg(root, task, run_id, version, tool_hash, effort="default", hit=(1000, 950), ended_at=None, wall=60):
    """A synthetic leg: meta, wall_seconds (mtime = its end), a trace with
    one tool hash, effort_bound, and a session log whose usage gives `hit`."""
    w = os.path.join(root, f"kiso-{task}-{run_id}")
    end = ended_at if ended_at is not None else time.time()
    write(os.path.join(w, "meta.json"), json.dumps({"kisoVersion": version, "createdAt": int((end - wall) * 1000)}))
    write(os.path.join(w, "wall_seconds"), f"{wall}\n")
    os.utime(os.path.join(w, "wall_seconds"), (end, end))
    write(os.path.join(w, "effort_bound"), effort + "\n")
    hashes = tool_hash if isinstance(tool_hash, list) else [tool_hash]
    jsonl(os.path.join(w, "kiso-home", "sessions", "traces", "s.jsonl"), [{"kind": "request", "runId": "r", "toolSchemaHash": h} for h in hashes])
    jsonl(os.path.join(w, "kiso-home", "sessions", "s.jsonl"), [{"runId": "r", "ts": 0, "event": {"type": "usage", "inputTokens": hit[0], "cacheRead": hit[1], "outputTokens": 1}}])
    return w


RC_H, CTL_H = "a" * 64, "b" * 64


class Audit(unittest.TestCase):
    def audit(self, root, *extra):
        r = run(["node", "audit-legs.mjs", root, "T5", "--rc=0.48.0-rc.1", "--ctl=0.47.0", *extra])
        return r.returncode, json.loads(r.stdout)

    def pmset(self, root, text=""):
        p = os.path.join(root, "pmset.txt")
        write(p, text)
        return f"--pmset={p}"

    def test_a_clean_set_voids_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            for i in (1, 2):
                leg(root, "T5", f"rc{i}", "0.48.0-rc.1", RC_H); leg(root, "T5", f"ctl{i}", "0.47.0", CTL_H)
            code, out = self.audit(root, self.pmset(root))
            self.assertEqual(code, 0, out)
            self.assertEqual(out["voidPairs"], [])
            self.assertEqual(out["armHash"], {"rc": "aaaaaaaa", "ctl": "bbbbbbbb"})
            self.assertFalse(any(os.path.exists(os.path.join(root, d, "void")) for d in os.listdir(root) if d.startswith("kiso-")))

    def test_each_cause_voids_its_pair_and_names_itself(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "T5", "rc1", "0.48.0-rc.10", RC_H); leg(root, "T5", "ctl1", "0.47.0", CTL_H)       # version (substring would pass)
            leg(root, "T5", "rc2", "0.48.0-rc.1", [RC_H, CTL_H]); leg(root, "T5", "ctl2", "0.47.0", CTL_H)   # two tool tables in one leg
            leg(root, "T5", "rc3", "0.48.0-rc.1", RC_H, effort="high"); leg(root, "T5", "ctl3", "0.47.0", CTL_H)  # effort differs in the pair
            leg(root, "T5", "rc4", "0.48.0-rc.1", RC_H, hit=(1000, 500)); leg(root, "T5", "ctl4", "0.47.0", CTL_H, hit=(1000, 950))  # cache collapse
            slept_end = time.time() - 3600
            leg(root, "T5", "rc5", "0.48.0-rc.1", RC_H, ended_at=slept_end); leg(root, "T5", "ctl5", "0.47.0", CTL_H)
            when = time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(slept_end - 30))
            leg(root, "T5", "rc6", "0.48.0-rc.1", RC_H); leg(root, "T5", "ctl6", "0.47.0", CTL_H)  # clean
            code, out = self.audit(root, self.pmset(root, f"{when} Sleep               \tEntering Sleep state\n"))
            self.assertEqual(code, 1)
            self.assertEqual(out["voidPairs"], ["1", "2", "3", "4", "5"])
            self.assertEqual(out["pairList"], "1 2 3 4 5")
            causes = {l["run"]: l["causes"][0].split(":")[0] for l in out["legs"] if l["causes"]}
            self.assertEqual((causes["rc1"], causes["rc2"], causes["rc3"], causes["rc4"], causes["rc5"]), ("version", "tool_hash", "effort", "cache_collapse", "machine_sleep"))
            self.assertEqual(causes["ctl1"], "pair")  # its partner voided it
            self.assertTrue(read(os.path.join(root, "kiso-T5-rc1", "void")).startswith("VOID (audit): version"))
            self.assertFalse(os.path.exists(os.path.join(root, "kiso-T5-rc6", "void")))
            # the audit is idempotent: a second pass voids nothing new
            code2, out2 = self.audit(root, self.pmset(root, f"{when} Sleep               \tEntering Sleep state\n"))
            self.assertEqual((code2, out2["voidPairs"]), (0, []))

    def test_arms_with_the_same_tool_table_are_an_instrument_failure(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "T5", "rc1", "0.48.0-rc.1", RC_H); leg(root, "T5", "ctl1", "0.47.0", RC_H)
            code, out = self.audit(root, self.pmset(root))
            self.assertEqual(code, 2)
            self.assertIn("the arms are not what the round compares", out["instrument"][0])

    def test_a_round_that_expects_the_same_tool_table_flips_the_rule(self):
        # 0.48.0: the kit expects the request prefix unchanged against the control
        with tempfile.TemporaryDirectory() as root:
            leg(root, "T5", "rc1", "0.48.0-rc.1", RC_H); leg(root, "T5", "ctl1", "0.47.0", RC_H)
            code, out = self.audit(root, self.pmset(root), "--tool-tables=same")
            self.assertEqual((code, out["instrument"]), (0, []))  # identical tables: expected, clean
        with tempfile.TemporaryDirectory() as root:
            leg(root, "T5", "rc1", "0.48.0-rc.1", RC_H); leg(root, "T5", "ctl1", "0.47.0", CTL_H)
            code, out = self.audit(root, self.pmset(root), "--tool-tables=same")
            self.assertEqual(code, 2)
            self.assertIn("the kit expects them the same", out["instrument"][0])
            self.assertFalse(os.path.exists(os.path.join(root, "kiso-T5-rc1", "void")))  # never a void: a re-run cannot change it
        with tempfile.TemporaryDirectory() as root:
            leg(root, "T5", "rc1", "0.48.0-rc.1", RC_H); leg(root, "T5", "ctl1", "0.47.0", RC_H)
            r = run(["node", "audit-legs.mjs", root, "T5", "--rc=0.48.0-rc.1", "--ctl=0.47.0", "--tool-tables=maybe", self.pmset(root)])
            self.assertEqual(r.returncode, 2)

    def test_an_rc_only_probe_lists_legs_to_replace_not_pairs(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "F1b", "rc1", "0.48.0-rc.1", RC_H); leg(root, "F1b", "rc2", "0.48.0-rc", RC_H)
            r = run(["node", "audit-legs.mjs", root, "F1b", "--rc=0.48.0-rc.1", self.pmset(root)])
            out = json.loads(r.stdout)
            self.assertEqual((r.returncode, out["replaceLegs"], out["voidPairs"]), (1, ["rc2"], []))


class RerunPaths(unittest.TestCase):
    def test_run_paired_reruns_exactly_the_listed_pairs_under_the_suffix(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            env = dict(fake_env(tmp), KISO_BIN_RC="kiso", KISO_BIN_CTL="kiso", RC_VERSION="9.9.9", CTL_VERSION="9.9.9", PAIR_LIST="2", PAIR_SUFFIX="c")
            r = subprocess.run(["sh", os.path.join(B, "run-paired.sh"), "T3", "12"], capture_output=True, text=True, env=env, timeout=180)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            legs = sorted(d for d in os.listdir(os.path.join(tmp, "runs", "e2e")) if d.startswith("kiso-T3-"))
            self.assertEqual(legs, ["kiso-T3-ctl2c", "kiso-T3-rc2c"])
            self.assertIn("pairs list:2", r.stdout)

    def test_the_version_match_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            env = dict(fake_env(tmp), KISO_BIN_RC="kiso", RC_VERSION="9.9", PROBE_FIRST="7")
            r = subprocess.run(["sh", os.path.join(B, "run-probe.sh"), "F1b", "1"], capture_output=True, text=True, env=env, timeout=180)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            w = os.path.join(tmp, "runs", "e2e", "kiso-F1b-rc7")  # PROBE_FIRST: the next run id
            self.assertTrue(os.path.isdir(w))
            self.assertIn("wanted exactly 9.9", read(os.path.join(w, "void")))  # "9.9.9" contains "9.9": substring would have passed


class NullCalibration(unittest.TestCase):
    """null-calibration.mjs: a null set's resolution, seeded and repeatable."""

    def calibrate(self, a, b, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            pa, pb = os.path.join(tmp, "a.json"), os.path.join(tmp, "b.json")
            write(pa, json.dumps(a)); write(pb, json.dumps(b))
            r = run(["node", "null-calibration.mjs", pa, pb, "--resamples=2000", *extra])
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout)

    def rows(self, deltas):
        a = [{"task": "T5", "run": str(i), "cost_weighted": 100.0 * (1 + d), "wall": 10, "verify": "pass"} for i, d in enumerate(deltas)]
        b = [{"task": "T5", "run": str(i), "cost_weighted": 100.0, "wall": 10, "verify": "pass"} for i, _ in enumerate(deltas)]
        return a, b

    def test_a_tight_null_resolves_and_a_wide_one_projects_the_n(self):
        tight = self.calibrate(*self.rows([0.01, -0.02, 0.03, -0.01, 0.0, 0.02, -0.03, 0.01, -0.02, 0.02, 0.0, -0.01]), "--seed=t")
        self.assertEqual((tight["n"], tight["resolves"]), (12, True))
        self.assertNotIn("nFor", tight)
        wide = self.calibrate(*self.rows([0.9, -0.6, 0.7, -0.5, 0.8, -0.7, 0.6, -0.9, 0.5, -0.8, 0.7, -0.6]), "--seed=t")
        self.assertFalse(wide["resolves"])
        self.assertTrue(wide["nFor"]["projected"])
        self.assertGreater(wide["nFor"]["n"], 12)

    def test_the_same_seed_gives_the_same_numbers(self):
        a, b = self.rows([0.3, -0.2, 0.1, -0.4, 0.2, 0.0, -0.1, 0.5, -0.3, 0.2, 0.1, -0.2])
        self.assertEqual(self.calibrate(a, b, "--seed=s")["cost"], self.calibrate(a, b, "--seed=s")["cost"])


if __name__ == "__main__":
    unittest.main()
