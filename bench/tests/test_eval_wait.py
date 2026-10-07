"""ADR-0059 release 1 — the wait chains' bench pieces (kiso-doc
bench-plan-wait-release-1-2026-10-06): the feeder keeps a leg alive while a
wait is pending and treats a wait's end like any task end; the counters
read the waits, the chain, each wake's cold prefix and the empty-promise
heuristic from a leg's own records; the W2 fake `gh` answers pending, then
a conclusion that follows the repo's own tests (seven pending polls since the 0.47.0 kit); run-task.sh wires W1/W2.

Run: python3 tests/test_eval_wait.py   (from bench/; npm run check runs it)
"""
import json, os, shutil, subprocess, sys, tempfile, unittest

B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_eval_0460 import fake_env, node, read, write_jsonl  # noqa: E402


def write_journal(sessions, sid, tid, records):
    d = os.path.join(sessions, f"{sid}.tasks", tid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "journal.jsonl"), "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def write_records(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


WAIT_PLANNED = {"type": "planned", "ts": 1000, "taskId": "t1", "backend": "process", "command": "timer ms=20000", "cwd": "", "profile": "wait", "executionId": "ex-1", "wait": {"source": {"kind": "timer", "ms": 20000}, "deadlineAt": 21000}}


class FeederWait(unittest.TestCase):
    def idle(self, s):
        return node(f"import('./feed-until-idle.mjs').then(m => console.log(m.idleNow({json.dumps(s)}, 'x', () => false)))")

    def test_a_pending_wait_holds_the_session_open_and_its_end_releases_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = os.path.join(tmp, "s")
            write_jsonl(os.path.join(s, "x.jsonl"), [{"type": "user_input"}, {"type": "stop", "reason": "end_turn"}, {"type": "terminal", "outcome": {"kind": "completed"}}])
            self.assertEqual(self.idle(s), "true")
            write_journal(s, "x", "t1", [WAIT_PLANNED])
            self.assertEqual(self.idle(s), "false")  # waiting: no runner, no terminal, and live
            write_journal(s, "x", "t1", [WAIT_PLANNED, {"type": "wait_fired", "ts": 21000, "eventId": "timer:21000", "payload": {}}])
            self.assertEqual(self.idle(s), "true")
            write_journal(s, "x", "t2", [WAIT_PLANNED, {"type": "wait_expired", "ts": 21000}])
            self.assertEqual(self.idle(s), "true")

    def test_a_waits_end_restarts_the_quiet_clock_like_a_task_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = os.path.join(tmp, "s")
            write_journal(s, "x", "t1", [WAIT_PLANNED, {"type": "wait_fired", "ts": 777_000, "eventId": "e", "payload": {}}])
            self.assertEqual(node(f"import('./feed-until-idle.mjs').then(m => console.log(m.lastTaskEnd({json.dumps(os.path.join(s, 'x.tasks'))})))"), "777000")


def chain_leg(tmp):
    """A synthetic leg: the person's run registers a timer wait; two wake
    runs follow (a chain of 2), the second registers nothing and promises
    to report later; a third run is the person's again."""
    s = os.path.join(tmp, "kiso-home", "sessions")
    sid = "bench-W1-x"
    ev = []
    def rec(run, e):
        ev.append({"runId": run, "ts": 0, "event": e})
    rec("r1", {"type": "user_input", "content": "go"})
    rec("r1", {"type": "tool_call_end", "callId": "a", "name": "wait", "input": {"for": {"kind": "timer", "ms": 20000}}})
    rec("r1", {"type": "stop", "reason": "tool_use"}); rec("r1", {"type": "usage", "inputTokens": 1000, "cacheRead": 0, "outputTokens": 10})
    rec("r1", {"type": "text_delta", "text": "Waiting 20 seconds."})
    rec("r1", {"type": "stop", "reason": "end_turn"}); rec("r1", {"type": "usage", "inputTokens": 1100, "cacheRead": 1000, "outputTokens": 10})
    rec("r1", {"type": "terminal", "outcome": {"kind": "completed"}})
    rec("r2", {"type": "user_input", "content": "<kiso-wait id=\"t1\" status=\"fired\"/>", "source": "system", "via": {"kind": "tasks", "items": [{"taskId": "t1", "transition": "exited"}]}})
    rec("r2", {"type": "tool_call_end", "callId": "b", "name": "wait", "input": {"for": {"kind": "timer", "ms": 20000}}})
    rec("r2", {"type": "stop", "reason": "tool_use"}); rec("r2", {"type": "usage", "inputTokens": 1200, "cacheRead": 1100, "outputTokens": 10})
    rec("r2", {"type": "stop", "reason": "end_turn"}); rec("r2", {"type": "usage", "inputTokens": 1300, "cacheRead": 1200, "outputTokens": 10})
    rec("r2", {"type": "terminal", "outcome": {"kind": "completed"}})
    rec("r3", {"type": "user_input", "content": "<kiso-wait id=\"t2\" status=\"fired\"/>", "source": "system", "via": {"kind": "tasks", "items": [{"taskId": "t2", "transition": "exited"}]}})
    rec("r3", {"type": "text_delta", "text": "All green. I'll let you know when the next run finishes."})
    rec("r3", {"type": "stop", "reason": "end_turn"}); rec("r3", {"type": "usage", "inputTokens": 1400, "cacheRead": 1300, "outputTokens": 10})
    rec("r3", {"type": "terminal", "outcome": {"kind": "completed"}})
    rec("r4", {"type": "user_input", "content": "thanks"})
    rec("r4", {"type": "stop", "reason": "end_turn"}); rec("r4", {"type": "usage", "inputTokens": 1500, "cacheRead": 1400, "outputTokens": 10})
    rec("r4", {"type": "terminal", "outcome": {"kind": "completed"}})
    write_records(os.path.join(s, f"{sid}.jsonl"), ev)
    # the trace sidecar: the first request of each run carries its fresh input
    write_records(os.path.join(s, "traces", f"{sid}.jsonl"), [
        {"kind": "request", "runId": "r1", "requestIndex": 0, "freshInput": 1000, "canonical": {"input": 1000}},
        {"kind": "request", "runId": "r1", "requestIndex": 1, "freshInput": 100, "canonical": {"input": 100}},
        {"kind": "request", "runId": "r2", "requestIndex": 0, "freshInput": 240, "canonical": {"input": 240}},
        {"kind": "request", "runId": "r2", "requestIndex": 1, "freshInput": 50, "canonical": {"input": 50}},
        # r3 has no request record (untraced): null, never 0
        {"kind": "request", "runId": "r4", "requestIndex": 0, "freshInput": 90, "canonical": {"input": 90}},
    ])
    fired = lambda tid, ts: [dict(WAIT_PLANNED, taskId=tid), {"type": "wait_fired", "ts": ts, "eventId": f"timer:{ts}", "payload": {"firedAt": ts}}]
    write_journal(s, sid, "t1", fired("t1", 21000))
    write_journal(s, sid, "t2", fired("t2", 42000))
    write_journal(s, sid, "t3", [dict(WAIT_PLANNED, taskId="t3", wait={"source": {"kind": "gh-checks", "pr": 207}, "deadlineAt": 99000}), {"type": "wait_expired", "ts": 99000}])
    write_journal(s, sid, "t4", [dict(WAIT_PLANNED, taskId="t4"), {"type": "stop_requested", "ts": 2000, "by": "model"}, {"type": "terminal", "ts": 2001, "exitCode": None, "signal": None}])
    write_journal(s, sid, "t5", [dict(WAIT_PLANNED, taskId="t5")])
    return tmp


class CountersWait(unittest.TestCase):
    def test_waits_chain_cold_prefix_and_empty_promises(self):
        with tempfile.TemporaryDirectory() as tmp:
            chain_leg(tmp)
            c = json.loads(node(f"import('./tasks-counters.mjs').then(m => console.log(JSON.stringify(m.counters({json.dumps(tmp)}))))"))
            self.assertEqual(c["waits"], {"count": 5, "byKind": {"timer": 4, "gh-checks": 1}, "fired": 2, "expired": 1, "stopped": 1, "failed": 0, "pending": 1})
            self.assertEqual(c["wakes"], 2)
            self.assertEqual(c["chainLen"], 2)
            self.assertEqual(c["wakeColdPrefix"], [240, None])  # r2's first request; r3 untraced is null, never 0
            self.assertEqual(c["emptyPromises"], 1)  # r3 promised and registered nothing; r1 said "Waiting" and registered a wait

    def test_a_leg_without_waits_counts_zeros_and_the_old_counters_are_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = os.path.join(tmp, "kiso-home", "sessions")
            write_jsonl(os.path.join(s, "bench-T3-x.jsonl"), [{"type": "user_input", "content": "go"}, {"type": "stop", "reason": "end_turn"}, {"type": "usage", "inputTokens": 10, "cacheRead": 0, "outputTokens": 1}, {"type": "terminal", "outcome": {"kind": "completed"}}])
            c = json.loads(node(f"import('./tasks-counters.mjs').then(m => console.log(JSON.stringify(m.counters({json.dumps(tmp)}))))"))
            self.assertEqual((c["waits"]["count"], c["chainLen"], c["wakeColdPrefix"], c["emptyPromises"], c["wakes"]), (0, 0, [], 0, 0))


class FakeGh(unittest.TestCase):
    """The W2 fake: pending for seven polls, then a conclusion that follows
    the repo's own tests; a served conclusion restarts the pending count."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "bin"))
        shutil.copy(os.path.join(B, "fixture-w2-gh", "gh"), os.path.join(self.tmp, "bin", "gh"))
        os.chmod(os.path.join(self.tmp, "bin", "gh"), 0o755)
        shutil.copytree(os.path.join(B, "fixture-w"), os.path.join(self.tmp, "repo"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def gh(self, *args):
        r = subprocess.run([os.path.join(self.tmp, "bin", "gh"), *args], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_pending_seven_times_then_fail_on_the_buggy_tree_then_pass_once_fixed(self):
        self.assertEqual(self.gh("pr", "view", "207", "--json", "headRefOid"), {"headRefOid": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"})
        checks = lambda: {c["name"]: c["bucket"] for c in self.gh("pr", "checks", "207", "--json", "name,state,bucket,link,workflow")}
        for _ in range(7):
            self.assertEqual(checks()["test"], "pending")
        self.assertEqual(checks(), {"test": "fail", "lint": "pass"})  # the fixture's clamp bug
        # a re-armed wait sees pending again, then the conclusion follows the fix
        self.assertEqual(checks()["test"], "pending")
        src = os.path.join(self.tmp, "repo", "src", "range.js")
        with open(src) as f:
            fixed = f.read().replace("if (n >= max) return max - 1;", "if (n > max) return max;")
        with open(src, "w") as f:
            f.write(fixed)
        for _ in range(6):
            self.assertEqual(checks()["test"], "pending")
        self.assertEqual(checks(), {"test": "pass", "lint": "pass"})


class RunTaskWait(unittest.TestCase):
    def test_the_prompts_name_the_tool_and_forbid_polling(self):
        tasks = json.loads(read(os.path.join(B, "tasks-wait.json")))
        for k in ("W1", "W2"):
            self.assertIn("wait tool", tasks[k])
            self.assertIn("do not sleep", tasks[k].lower())
        self.assertIn('"kind": "timer"', tasks["W1"])
        self.assertIn('"kind": "gh-checks"', tasks["W2"])

    def test_w2_wires_the_fake_gh_and_the_poll_knob_and_writes_every_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            env = fake_env(tmp)
            r = subprocess.run(["sh", os.path.join(B, "run-task.sh"), "W2", "e1"], capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            w = os.path.join(tmp, "runs", "e2e", "kiso-W2-e1")
            for rec in ["meta.json", "wall_seconds", "exit", "status", "verify", "counters.json"]:
                self.assertTrue(os.path.exists(os.path.join(w, rec)), rec)
            self.assertEqual(read(os.path.join(w, "status")).strip(), "complete")
            self.assertEqual(read(os.path.join(w, "verify")).strip(), "fail")  # the fake kiso fixes nothing: the clamp bug stands
            self.assertTrue(os.access(os.path.join(w, "bin", "gh"), os.X_OK))
            self.assertTrue(os.path.isdir(os.path.join(w, "gh-state")))
            self.assertEqual(json.loads(read(os.path.join(w, "counters.json")))["waits"]["count"], 0)
            self.assertEqual(json.loads(read(os.path.join(w, "meta.json")))["task"], "W2")


if __name__ == "__main__":
    unittest.main()
