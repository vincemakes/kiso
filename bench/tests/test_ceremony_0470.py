"""The 0.47.0 release gate's machinery (kiso-doc kit-0470-ceremony rev 2):
the registered n as a machine gate (paired-compare --expect-pairs, INVALID
not FAIL), exact version matching in both runners, run-paired's pair list
and run-probe's first run id (the re-run paths), the read-only void audit
(version, tool hash, effort, cache collapse, machine sleep; identical arms
are an instrument failure), and the wait probe gates (the idle wake gated,
W-F1 gated, gh by the model gated).

Run: python3 tests/test_ceremony_0470.py   (from bench/; npm run check runs it)
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
        r = run(["node", "audit-legs.mjs", root, "T5", "--rc=0.47.0", "--ctl=0.46.2", *extra])
        return r.returncode, json.loads(r.stdout)

    def pmset(self, root, text=""):
        p = os.path.join(root, "pmset.txt")
        write(p, text)
        return f"--pmset={p}"

    def test_a_clean_set_voids_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            for i in (1, 2):
                leg(root, "T5", f"rc{i}", "0.47.0", RC_H); leg(root, "T5", f"ctl{i}", "0.46.2", CTL_H)
            code, out = self.audit(root, self.pmset(root))
            self.assertEqual(code, 0, out)
            self.assertEqual(out["voidPairs"], [])
            self.assertEqual(out["armHash"], {"rc": "aaaaaaaa", "ctl": "bbbbbbbb"})
            self.assertFalse(any(os.path.exists(os.path.join(root, d, "void")) for d in os.listdir(root) if d.startswith("kiso-")))

    def test_each_cause_voids_its_pair_and_names_itself(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "T5", "rc1", "0.47.0-rc.1", RC_H); leg(root, "T5", "ctl1", "0.46.2", CTL_H)       # version (substring would pass)
            leg(root, "T5", "rc2", "0.47.0", [RC_H, CTL_H]); leg(root, "T5", "ctl2", "0.46.2", CTL_H)   # two tool tables in one leg
            leg(root, "T5", "rc3", "0.47.0", RC_H, effort="high"); leg(root, "T5", "ctl3", "0.46.2", CTL_H)  # effort differs in the pair
            leg(root, "T5", "rc4", "0.47.0", RC_H, hit=(1000, 500)); leg(root, "T5", "ctl4", "0.46.2", CTL_H, hit=(1000, 950))  # cache collapse
            slept_end = time.time() - 3600
            leg(root, "T5", "rc5", "0.47.0", RC_H, ended_at=slept_end); leg(root, "T5", "ctl5", "0.46.2", CTL_H)
            when = time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(slept_end - 30))
            leg(root, "T5", "rc6", "0.47.0", RC_H); leg(root, "T5", "ctl6", "0.46.2", CTL_H)  # clean
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
            leg(root, "T5", "rc1", "0.47.0", RC_H); leg(root, "T5", "ctl1", "0.46.2", RC_H)
            code, out = self.audit(root, self.pmset(root))
            self.assertEqual(code, 2)
            self.assertIn("the arms are not what the round compares", out["instrument"][0])

    def test_an_rc_only_probe_lists_legs_to_replace_not_pairs(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "W1", "rc1", "0.47.0", RC_H); leg(root, "W1", "rc2", "0.46.9", RC_H)
            r = run(["node", "audit-legs.mjs", root, "W1", "--rc=0.47.0", self.pmset(root)])
            out = json.loads(r.stdout)
            self.assertEqual((r.returncode, out["replaceLegs"], out["voidPairs"]), (1, ["rc2"], []))


def wleg(root, run_id, task="W1", verify="pass", wakes=2, waits=None, sleep=False, gh=False):
    """A synthetic W leg: `wakes` wake runs after the person's run; waits by spec."""
    w = os.path.join(root, f"kiso-{task}-{run_id}")
    write(os.path.join(w, "verify"), verify + "\n")
    ev = [{"type": "user_input", "content": "go"}]
    if sleep:
        ev.append({"type": "tool_execution_started", "name": "shell", "executionId": "s", "input": {"command": "sleep 20"}})
    if gh:
        ev.append({"type": "tool_call_end", "callId": "g", "name": "shell", "input": {"command": "gh pr checks 207"}})
    ev += [{"type": "stop", "reason": "end_turn"}, {"type": "terminal", "outcome": {"kind": "completed"}}]
    for i in range(wakes):
        ev += [{"type": "user_input", "content": "<kiso-wait/>", "source": "system", "via": {"kind": "tasks", "items": [{"taskId": f"t{i+1}", "transition": "exited"}]}},
               {"type": "stop", "reason": "end_turn"}, {"type": "terminal", "outcome": {"kind": "completed"}}]
    jsonl(os.path.join(w, "kiso-home", "sessions", "s.jsonl"), [{"runId": "r", "ts": 0, "event": e} for e in ev])
    for i, spec in enumerate(waits if waits is not None else [("timer", {"ms": 20000}, "wait_fired")] * 2):
        kind, fields, end = spec
        recs = [{"type": "planned", "ts": 1, "taskId": f"t{i+1}", "profile": "wait", "wait": {"source": {"kind": kind, **fields}, "deadlineAt": 2}}]
        if end:
            recs.append({"type": end, "ts": 2, "eventId": "e", "payload": {}})
        jsonl(os.path.join(w, "kiso-home", "sessions", "s.tasks", f"t{i+1}", "journal.jsonl"), recs)
    return w


class GatesWait(unittest.TestCase):
    def gates(self, root, *extra):
        r = run(["node", "gates-wait.mjs", root, *extra])
        return r.returncode, json.loads(r.stdout)

    def test_clean_legs_pass_and_the_registered_n_is_counted(self):
        with tempfile.TemporaryDirectory() as root:
            wleg(root, "rc1"); wleg(root, "rc1", task="W2", wakes=1, waits=[("gh-checks", {"pr": 207}, "wait_fired")] * 2)
            self.assertEqual(self.gates(root, "--legs=1")[0], 0)
            code, out = self.gates(root, "--legs=2")
            self.assertEqual(code, 2)
            self.assertIn("W1: 1 valid legs, 2 registered", out["instrument"][0])

    def test_the_idle_wake_is_gated_not_assumed(self):
        with tempfile.TemporaryDirectory() as root:
            wleg(root, "rc1", wakes=1)  # W1 with one wake: the chain never formed
            wleg(root, "rc1", task="W2", wakes=0, waits=[("gh-checks", {"pr": 207}, "wait_fired")] * 2)  # both landed in the live run
            code, out = self.gates(root)
            self.assertEqual(code, 1)
            self.assertIn("kiso-W1-rc1: wakes 1 < 2", out["blocks"])
            self.assertIn("kiso-W1-rc1: chainLen 1 < 2", out["blocks"])
            self.assertIn("kiso-W2-rc1: wakes 0 < 1", out["blocks"])

    def test_w_f1_sleep_gh_and_expiry_block(self):
        with tempfile.TemporaryDirectory() as root:
            wleg(root, "rc1", waits=[("timer", {"ms": 20000}, "wait_fired"), ("task", {"id": "t1"}, "wait_fired"), ("timer", {"ms": 1}, "wait_fired")])
            wleg(root, "rc2", sleep=True)
            wleg(root, "rc1", task="W2", wakes=1, gh=True, waits=[("gh-checks", {"pr": 207}, "wait_fired"), ("gh-checks", {"pr": 207}, "wait_expired")])
            code, out = self.gates(root)
            self.assertEqual(code, 1)
            for b in ["kiso-W1-rc1: waitOnWait 1", "kiso-W1-rc1: subSecondTimers 1", "kiso-W1-rc2: sleepCalls 1", "kiso-W2-rc1: ghShellCalls 1", "kiso-W2-rc1: expired 1 + failed 0 > 0", "kiso-W2-rc1: waits.fired 1 < 2"]:
                self.assertIn(b, out["blocks"])

    def test_a_void_leg_is_not_judged(self):
        with tempfile.TemporaryDirectory() as root:
            w = wleg(root, "rc1", verify="fail")
            write(os.path.join(w, "void"), "VOID (audit): machine_sleep\n")
            wleg(root, "rc2")
            code, out = self.gates(root, "--legs=1")
            self.assertEqual(code, 2)  # W2 has no legs at all
            self.assertEqual([l["leg"] for l in out["legs"]], ["kiso-W1-rc2"])


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
            r = subprocess.run(["sh", os.path.join(B, "run-probe.sh"), "W1", "1"], capture_output=True, text=True, env=env, timeout=180)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            w = os.path.join(tmp, "runs", "e2e", "kiso-W1-rc7")  # PROBE_FIRST: the next run id
            self.assertTrue(os.path.isdir(w))
            self.assertIn("wanted exactly 9.9", read(os.path.join(w, "void")))  # "9.9.9" contains "9.9": substring would have passed


if __name__ == "__main__":
    unittest.main()
