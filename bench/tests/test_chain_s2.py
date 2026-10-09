"""S-chain (the 0.48.0 kit): the S2 task, its wiring in run-task.sh, and
gates-chain.mjs over synthetic legs — an rc leg whose two background
groups both woke the session passes; one whose second group only notified
blocks; a control leg that passes every rc gate is an instrument failure
(the premise: the control's lineage depth 1 stops the second wake).

Run: python3 tests/test_chain_s2.py   (from bench/; npm run check runs it)
"""
import json, os, subprocess, sys, tempfile, unittest

B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_eval_0460 import fake_env, read, write_journal  # noqa: E402


def leg(root, run, second_wake=True, verify="pass", left_running=False):
    """Two groups of three background explorers. Group one starts in the
    person's run; its end wakes run two, which starts group two; group
    two's end wakes run three (second_wake) — or never does (the control)."""
    sid = f"bench-S2-{run}"
    w = os.path.join(root, f"kiso-S2-{run}")
    s = os.path.join(w, "kiso-home", "sessions")
    ev = []
    seq = [0]

    def e(event):
        seq[0] += 1
        ev.append({"runId": "r", "ts": seq[0], "event": dict(event, seq=seq[0])})

    def group(first_task):
        calls = []
        for k in range(3):
            e({"type": "tool_call_end", "callId": f"c{first_task + k}", "name": "delegate", "input": {"background": True}})
            calls.append(seq[0])
        e({"type": "stop", "reason": "tool_use"})
        for k, inv in enumerate(calls):
            e({"type": "tool_execution_started", "executionId": f"ex{first_task + k}", "invocationSeq": inv, "name": "delegate", "input": {"background": True}})
            e({"type": "tool_result", "callId": f"c{first_task + k}", "executionId": f"ex{first_task + k}", "content": f"started background task t{first_task + k}", "isError": False})
        e({"type": "stop", "reason": "end_turn"})
        e({"type": "terminal", "outcome": {"kind": "completed"}})

    e({"type": "user_input", "content": "go"})
    group(1)
    e({"type": "user_input", "source": "system", "content": "<kiso-task/>", "via": {"kind": "tasks", "items": [{"taskId": f"t{i}", "transition": "exited"} for i in (1, 2, 3)]}})
    group(4)
    if second_wake:
        e({"type": "user_input", "source": "system", "content": "<kiso-task/>", "via": {"kind": "tasks", "items": [{"taskId": f"t{i}", "transition": "exited"} for i in (4, 5, 6)]}})
        e({"type": "text_delta", "text": "1) … 6) …"})
        e({"type": "stop", "reason": "end_turn"})
        e({"type": "terminal", "outcome": {"kind": "completed"}})
    os.makedirs(s, exist_ok=True)
    with open(os.path.join(s, f"{sid}.jsonl"), "w") as f:
        for r in ev:
            f.write(json.dumps(r) + "\n")
    for i in range(1, 7):
        recs = [{"type": "planned", "ts": 1, "taskId": f"t{i}", "backend": "process", "profile": "oneshot", "executionId": f"ex{i}", "agent": {"role": "explorer", "session": f"sub-t{i}"}}]
        if not (left_running and i == 6):
            recs.append({"type": "terminal", "ts": 2, "exitCode": 0, "signal": None})
        write_journal(s, sid, f"t{i}", recs)
    with open(os.path.join(w, "verify"), "w") as f:
        f.write(verify + "\n")
    return w


class GatesChain(unittest.TestCase):
    def gate(self, root, *extra):
        r = subprocess.run(["node", os.path.join(B, "gates-chain.mjs"), root, *extra], capture_output=True, text=True, cwd=B)
        return r.returncode, json.loads(r.stdout)

    def test_both_groups_woke_the_session_passes(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "rc1")
            code, out = self.gate(root, "--legs=1")
            self.assertEqual(code, 0, out)
            self.assertEqual((out["rc"][0]["wakes"], out["rc"][0]["groups"], out["rc"][0]["members"]), (2, 2, [3, 3]))

    def test_a_second_group_that_only_notified_blocks(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "rc1", second_wake=False, verify="fail")
            code, out = self.gate(root)
            self.assertEqual(code, 1)
            for b in ["kiso-S2-rc1: verify fail", "kiso-S2-rc1: wakes 1 < 2", "kiso-S2-rc1: deliveredOnce false"]:
                self.assertIn(b, out["blocks"])

    def test_a_child_left_running_blocks(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "rc1", left_running=True)
            self.assertIn("kiso-S2-rc1: children left running 1", self.gate(root)[1]["blocks"])

    def test_the_control_is_reported_and_a_passing_control_breaks_the_premise(self):
        with tempfile.TemporaryDirectory() as root:
            leg(root, "rc1"); leg(root, "ctl1", second_wake=False, verify="fail")
            code, out = self.gate(root)
            self.assertEqual(code, 0, out)  # the control's failure is reported, never gating
            self.assertEqual(out["ctl"][0]["wakes"], 1)
        with tempfile.TemporaryDirectory() as root:
            leg(root, "rc1"); leg(root, "ctl1")
            code, out = self.gate(root)
            self.assertEqual(code, 2)
            self.assertIn("the premise", out["instrument"][0])

    def test_the_registered_n_and_a_void_leg(self):
        with tempfile.TemporaryDirectory() as root:
            w = leg(root, "rc1")
            with open(os.path.join(w, "void"), "w") as f:
                f.write("VOID (audit): machine_sleep\n")
            leg(root, "rc2")
            code, out = self.gate(root, "--legs=2")
            self.assertEqual(code, 2)
            self.assertIn("1 valid rc legs, 2 registered", out["instrument"][0])


class TaskWiring(unittest.TestCase):
    def test_s2_asks_for_two_rounds_without_polling(self):
        t = json.loads(read(os.path.join(B, "tasks-0460.json")))["S2"]
        for needle in ["two rounds", "Round two starts only after round one has reported", "background: true", "Do not sleep or poll", "(6)"]:
            self.assertIn(needle, t)

    def test_run_task_runs_s2_on_f1s_fixture_and_writes_every_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            r = subprocess.run(["sh", os.path.join(B, "run-task.sh"), "S2", "e1"], capture_output=True, text=True, env=fake_env(tmp), timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            w = os.path.join(tmp, "runs", "e2e", "kiso-S2-e1")
            for rec in ["meta.json", "wall_seconds", "status", "verify", "counters.json"]:
                self.assertTrue(os.path.exists(os.path.join(w, rec)), rec)
            self.assertTrue(os.path.exists(os.path.join(w, "repo", "src")))
            self.assertEqual(json.loads(read(os.path.join(w, "meta.json")))["task"], "S2")
            self.assertEqual(read(os.path.join(w, "verify")).strip(), "pass")  # the fake's answer carries all six facts


if __name__ == "__main__":
    unittest.main()
