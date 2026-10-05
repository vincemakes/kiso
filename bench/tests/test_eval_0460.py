"""The 0.46.0 evaluation's bench pieces (kiso-doc plan-0460-3f-evaluation):
the per-leg counters, the route trial gate, the feeder's idle rule, the
paired-row split, the round spend, the F1 marks — and run-task.sh end to
end against a fake kiso, which proves the feeder keeps stdin open until the
session is idle and the leg writes every record it promises. eval-0460b
(kiso-doc plan-0460-fix-b1-b2 §4) adds the counter fixes I2-I5, F1b's
group/wake/poll counts, the leg gates (gates-0460b.mjs) and the rc-only
probe runner (run-probe.sh).

Run: python3 tests/test_eval_0460.py   (from bench/; npm run check runs it)
"""
import json, os, subprocess, sys, tempfile, textwrap, time, unittest

B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(path):
    with open(path) as f:
        return f.read()


def node(code):
    return subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, cwd=B, check=True).stdout.strip()


def write_jsonl(path, events):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for e in events:
            f.write(json.dumps({"runId": "r", "ts": 0, "event": e}) + "\n")


def leg(tmp):
    """A synthetic leg: one wake run, a promotion, a short background task,
    an alias hit, and one background child that spent its budget."""
    s = os.path.join(tmp, "kiso-home", "sessions")
    write_jsonl(os.path.join(s, "bench-F1-x.jsonl"), [
        {"type": "user_input", "content": "go"},
        {"type": "tool_call_end", "callId": "a", "name": "shell", "input": {"command": "npm test", "timeoutMs": 90000}},
        {"type": "stop", "reason": "tool_use"}, {"type": "usage", "inputTokens": 1000, "cacheRead": 0, "outputTokens": 10},
        {"type": "tool_result", "callId": "a", "content": "still running after 60000 ms; continued as background task t1 (not killed)", "isError": False},
        {"type": "tool_call_end", "callId": "b", "name": "shell", "input": {"command": "ls", "background": True}},
        {"type": "stop", "reason": "tool_use"}, {"type": "usage", "inputTokens": 1100, "cacheRead": 1000, "outputTokens": 10},
        {"type": "tool_call_end", "callId": "c", "name": "delegate", "input": {"tasks": [], "background": True}},
        {"type": "stop", "reason": "end_turn"}, {"type": "usage", "inputTokens": 1200, "cacheRead": 1100, "outputTokens": 10},
        {"type": "terminal", "outcome": {"kind": "completed"}},
        {"type": "user_input", "content": "<kiso-task …>", "source": "system", "via": {"kind": "tasks", "items": [{"taskId": "t1", "transition": "exited"}]}},
        {"type": "stop", "reason": "end_turn"}, {"type": "usage", "inputTokens": 1300, "cacheRead": 1200, "outputTokens": 10},
        {"type": "terminal", "outcome": {"kind": "completed"}},
    ])
    write_jsonl(os.path.join(s, "sub-child-1.jsonl"), [{"type": "stop"}] * 3 + [{"type": "usage", "inputTokens": 500, "cacheRead": 400, "outputTokens": 5}])
    t = os.path.join(s, "bench-F1-x.tasks")
    def journal(tid, recs, result=None):
        os.makedirs(os.path.join(t, tid), exist_ok=True)
        with open(os.path.join(t, tid, "journal.jsonl"), "w") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
        if result is not None:
            with open(os.path.join(t, tid, "result.json"), "w") as f:
                json.dump(result, f)
    journal("t1", [{"type": "planned", "ts": 0, "backend": "foreground"}, {"type": "terminal", "ts": 90000}])
    journal("t2", [{"type": "planned", "ts": 1000, "backend": "process"}, {"type": "terminal", "ts": 1800}])
    journal("t3", [{"type": "planned", "ts": 0, "backend": "process", "agent": {"role": "explorer", "session": "sub-child-1"}}, {"type": "terminal", "ts": 50000}], {"outcome": "incomplete", "requests": 3})


class Counters(unittest.TestCase):
    def test_a_leg_is_counted_from_its_own_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            leg(tmp)
            c = json.loads(node(f"import('./tasks-counters.mjs').then(m => console.log(JSON.stringify(m.counters({json.dumps(tmp)}))))"))
            self.assertEqual(c["promotions"], 1)
            self.assertEqual(c["aliasHits"], 1)
            self.assertEqual(c["backgroundStarts"], 2)
            self.assertEqual(c["backgroundShort"], 1)  # t2: 800 ms; t1 is a promotion, t3 a child
            self.assertEqual((c["notices"], c["wakes"], c["oneRequestWakes"]), (1, 1, 1))
            self.assertEqual(c["children"]["count"], 1)
            self.assertEqual(c["children"]["requests"], [3])
            self.assertEqual(c["children"]["budgetSpent"], 1)
            self.assertEqual(c["usagePerRequest"], 1.0)
            self.assertAlmostEqual(c["cacheHit"], (0 + 1000 + 1100 + 1200 + 400) / (1000 + 1100 + 1200 + 1300 + 500), places=3)

    def test_a_build_without_tasks_counts_zeros(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_jsonl(os.path.join(tmp, "kiso-home", "sessions", "bench-T3-x.jsonl"), [{"type": "user_input"}, {"type": "stop"}, {"type": "usage", "inputTokens": 10, "cacheRead": 0}, {"type": "terminal", "outcome": {"kind": "completed"}}])
            c = json.loads(node(f"import('./tasks-counters.mjs').then(m => console.log(JSON.stringify(m.counters({json.dumps(tmp)}))))"))
            self.assertEqual((c["promotions"], c["wakes"], c["children"]["count"]), (0, 0, 0))


class RouteTrial(unittest.TestCase):
    def verdict(self, events):
        return json.loads(node(f"import('./route-trial.mjs').then(m => console.log(JSON.stringify(m.trial({json.dumps(events)}))))"))

    def test_a_good_route_passes_every_check(self):
        v = self.verdict([{"type": "stop", "reason": "tool_use"}, {"type": "usage", "cacheRead": 0}, {"type": "stop", "reason": "end_turn"}, {"type": "usage", "cacheRead": 900}, {"type": "terminal", "outcome": {"kind": "completed"}}])
        self.assertTrue(v["ok"], v)

    def test_a_dropped_reasoning_a_cold_cache_and_a_double_usage_each_fail(self):
        no_second = self.verdict([{"type": "stop", "reason": "tool_use"}, {"type": "usage", "cacheRead": 0}, {"type": "terminal", "outcome": {"kind": "error"}}])
        self.assertFalse(no_second["checks"]["reasoningRoundTrip"])
        cold = self.verdict([{"type": "stop", "reason": "tool_use"}, {"type": "usage", "cacheRead": 0}, {"type": "stop", "reason": "end_turn"}, {"type": "usage", "cacheRead": 0}, {"type": "terminal", "outcome": {"kind": "completed"}}])
        self.assertFalse(cold["checks"]["cacheReads"])
        double = self.verdict([{"type": "stop", "reason": "tool_use"}, {"type": "usage", "cacheRead": 0}, {"type": "usage", "cacheRead": 0}, {"type": "stop", "reason": "end_turn"}, {"type": "usage", "cacheRead": 9}, {"type": "terminal", "outcome": {"kind": "completed"}}])
        self.assertFalse(double["checks"]["oneUsagePerRequest"])


class Feeder(unittest.TestCase):
    def test_idle_needs_a_finished_run_and_no_live_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = os.path.join(tmp, "s")
            write_jsonl(os.path.join(s, "x.jsonl"), [{"type": "user_input"}, {"type": "stop"}])
            idle = lambda: node(f"import('./feed-until-idle.mjs').then(m => console.log(m.idleNow({json.dumps(s)}, 'x', () => true)))")
            self.assertEqual(idle(), "false")  # the run has not ended
            write_jsonl(os.path.join(s, "x.jsonl"), [{"type": "user_input"}, {"type": "stop"}, {"type": "terminal", "outcome": {"kind": "completed"}}])
            self.assertEqual(idle(), "true")
            os.makedirs(os.path.join(s, "x.tasks", "t1"))
            with open(os.path.join(s, "x.tasks", "t1", "journal.jsonl"), "w") as f:
                f.write(json.dumps({"type": "planned"}) + "\n" + json.dumps({"type": "runner_started", "pid": 4242}) + "\n")
            self.assertEqual(idle(), "false")  # a live task holds the session open
            gone = node(f"import('./feed-until-idle.mjs').then(m => console.log(m.idleNow({json.dumps(s)}, 'x', () => false)))")
            self.assertEqual(gone, "true")  # a runner gone without a terminal is not waited for


class PairedRows(unittest.TestCase):
    def test_a_void_pair_is_dropped_whole_and_the_ids_pair(self):
        rows = [{"task": "L1", "run": r, "cost_weighted": 1} for r in ["rc1", "ctl1", "rc2", "ctl2", "rc3", "ctl3b", "rc3b"]]
        out = json.loads(node(f"import('./paired-rows.mjs').then(m => console.log(JSON.stringify(m.split({json.dumps(rows)}, (r) => r === 'ctl2'))))"))
        self.assertEqual(sorted(r["run"] for r in out["rc"]), ["1", "3b"])
        self.assertEqual(sorted(r["run"] for r in out["ctl"]), ["1", "3b"])
        self.assertEqual(out["dropped"], ["2"])


class Spend(unittest.TestCase):
    def test_spend_is_priced_from_the_legs_own_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_jsonl(os.path.join(tmp, "kiso-L1-rc1", "kiso-home", "sessions", "a.jsonl"), [{"type": "usage", "inputTokens": 1_000_000, "cacheRead": 0, "outputTokens": 1_000_000}])
            write_jsonl(os.path.join(tmp, "kiso-L1-ctl1", "kiso-home", "sessions", "b.jsonl"), [{"type": "usage", "inputTokens": 1_000_000, "cacheRead": 1_000_000, "outputTokens": 0}])
            self.assertEqual(node(f"import('./round-spend.mjs').then(m => console.log(m.roundSpend({json.dumps(tmp)}).toFixed(3)))"), "0.753")


class F1Marks(unittest.TestCase):
    def test_all_six_facts_or_the_question_fails(self):
        good = "1) 25, at most 200. 2) ABC-1234. 3) 404; 204. 4) INVENTORY_DB, data/inventory.db. 5) 4 attempts: 150 ms, then 300 ms. 6) src/reports/summary.js"
        marks = json.loads(node(f"import('./f1-verify.mjs').then(m => console.log(JSON.stringify(m.marks({json.dumps(good)}))))"))
        self.assertTrue(all(m["ok"] for m in marks))
        partial = json.loads(node(f"import('./f1-verify.mjs').then(m => console.log(JSON.stringify(m.marks({json.dumps(good.replace('300', '600'))}))))"))
        self.assertEqual([m["q"] for m in partial if not m["ok"]], [5])


def write_timed(path, records):
    """A session log whose records carry their own timestamps: [(ts, event), ...]."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for ts, e in records:
            f.write(json.dumps({"runId": "r", "ts": ts, "event": e}) + "\n")


def write_journal(sessions, sid, tid, records):
    d = os.path.join(sessions, sid + ".tasks", tid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "journal.jsonl"), "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def counted(tmp):
    return json.loads(node(f"import('./tasks-counters.mjs').then(m => console.log(JSON.stringify(m.counters({json.dumps(tmp)}))))"))


def notice(task_id, transition):
    return {"type": "user_input", "source": "system", "content": "<kiso-task/>", "via": {"kind": "tasks", "items": [{"taskId": task_id, "transition": transition}]}}


class CountersEval0460b(unittest.TestCase):
    def test_i2_a_server_the_model_stopped_is_not_a_short_background_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = os.path.join(tmp, "kiso-home", "sessions")
            write_jsonl(os.path.join(s, "x.jsonl"), [{"type": "user_input"}, {"type": "terminal", "outcome": {"kind": "completed"}}])
            write_journal(s, "x", "t1", [{"type": "planned", "ts": 0, "backend": "process"}, {"type": "stop_requested", "ts": 900, "by": "model"}, {"type": "terminal", "ts": 1000}])
            write_journal(s, "x", "t2", [{"type": "planned", "ts": 0, "backend": "process"}, {"type": "stop_requested", "ts": 900, "by": "person"}, {"type": "terminal", "ts": 1000}])
            write_journal(s, "x", "t3", [{"type": "planned", "ts": 0, "backend": "process"}, {"type": "terminal", "ts": 1000}])
            self.assertEqual(counted(tmp)["backgroundShort"], 2)  # t2 and t3; t1 is the model's own stop

    def test_i3_alias_hits_are_not_counted_on_a_build_before_0_46(self):
        for version, want in [("0.45.3", None), ("0.46.0", 1)]:
            with tempfile.TemporaryDirectory() as tmp:
                write_jsonl(os.path.join(tmp, "kiso-home", "sessions", "x.jsonl"), [{"type": "tool_call_end", "name": "shell", "input": {"command": "npm test", "timeoutMs": 90000}}])
                with open(os.path.join(tmp, "meta.json"), "w") as f:
                    json.dump({"kisoVersion": version}, f)
                self.assertEqual(counted(tmp)["aliasHits"], want, version)

    def test_i3_the_trace_header_names_the_build_when_meta_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_jsonl(os.path.join(tmp, "kiso-home", "sessions", "x.jsonl"), [{"type": "tool_call_end", "name": "shell", "input": {"timeoutMs": 1}}])
            os.makedirs(os.path.join(tmp, "kiso-home", "sessions", "traces"))
            with open(os.path.join(tmp, "kiso-home", "sessions", "traces", "x.jsonl"), "w") as f:
                f.write(json.dumps({"kind": "header", "kisoVersion": "0.45.3"}) + "\n")
            self.assertIsNone(counted(tmp)["aliasHits"])

    def test_i4_a_request_that_only_answers_a_notice_after_the_final_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_jsonl(os.path.join(tmp, "kiso-home", "sessions", "x.jsonl"), [
                {"type": "user_input", "content": "go"},
                {"type": "stop", "reason": "tool_use"},
                {"type": "stop", "reason": "end_turn"},  # the final answer
                notice("t2", "stopped"),
                {"type": "stop", "reason": "end_turn"},  # bought by the notice alone: counted
                {"type": "terminal", "outcome": {"kind": "completed"}},
                {"type": "user_input", "content": "next"},
                {"type": "stop", "reason": "end_turn"},
                {"type": "user_input", "content": "and a steer"},  # the person spoke: a new turn
                notice("t3", "exited"),
                {"type": "stop", "reason": "end_turn"},
                {"type": "terminal", "outcome": {"kind": "completed"}},
                notice("t4", "exited"),  # a wake run is a wake, not an acknowledgement
                {"type": "stop", "reason": "end_turn"},
                {"type": "terminal", "outcome": {"kind": "completed"}},
            ])
            c = counted(tmp)
            self.assertEqual(c["postFinalRequests"], 1)
            self.assertEqual((c["wakes"], c["wakeRequests"]), (1, [1]))

    def ready_leg(self, tmp, result, extra):
        """A background + readyWhen start at ts 100 and its result at 105, then `extra` records."""
        s = os.path.join(tmp, "kiso-home", "sessions")
        write_timed(os.path.join(s, "x.jsonl"), [
            (90, {"type": "user_input", "content": "go"}),
            (100, {"type": "tool_execution_started", "name": "shell", "input": {"command": "node server.js", "background": True, "readyWhen": "listening"}, "executionId": "ex-1"}),
            (105, {"type": "tool_result", "executionId": "ex-1", "content": result}),
        ] + extra)
        write_journal(s, "x", "t1", [{"type": "planned", "ts": 100, "backend": "process"}, {"type": "ready", "ts": 101, "match": "listening"}])
        return counted(tmp)["readyRace"]

    def test_i5_a_probe_before_the_model_is_told_ready_is_a_race(self):
        probe = lambda ts, ex: (ts, {"type": "tool_execution_started", "name": "shell", "input": {"command": "curl"}, "executionId": ex})
        with tempfile.TemporaryDirectory() as tmp:
            # 0.46.0 rc: told only by the later notice — the curl at 110 raced it, though the
            # process was ready at 101 (a count against the ready record would read 0 here)
            self.assertEqual(self.ready_leg(tmp, "started background task t1. Output: x", [probe(110, "ex-2"), (120, notice("t1", "ready")), probe(130, "ex-3")]), 1)
        with tempfile.TemporaryDirectory() as tmp:
            # the fixed path: the result itself says ready — nothing after it races
            self.assertEqual(self.ready_leg(tmp, "started background task t1; ready — the output contains \"listening\".", [probe(110, "ex-2")]), 0)
        for told in ["not ready after 60000 ms — no \"listening\" in the output yet; it keeps running as background task t1, …",
                     "started background task t1; stopped waiting for \"listening\" (moved on by the person) — not ready yet; …",
                     "background task t1 ended before it was ready (exit code 1)"]:
            with tempfile.TemporaryDirectory() as tmp:
                # the result states the task's state: the model knows it from there on
                self.assertEqual(self.ready_leg(tmp, told, [probe(110, "ex-2")]), 0, told)
        with tempfile.TemporaryDirectory() as tmp:
            # a probe from the same response, run while the start still waits: a real race
            self.assertEqual(self.ready_leg(tmp, "started background task t1; ready — the output contains \"listening\".", [probe(103, "ex-2")]), 1)

    def f1b_leg(self, tmp, notices, child_terminal=True):
        """Two background children from one delegate call, then `notices`."""
        s = os.path.join(tmp, "kiso-home", "sessions")
        write_timed(os.path.join(s, "x.jsonl"), [
            (1, {"type": "user_input", "content": "fan out"}),
            (2, {"type": "tool_call_end", "name": "delegate", "input": {"tasks": [{}, {}], "background": True}, "seq": 5}),
            (3, {"type": "stop", "reason": "tool_use"}),
            (4, {"type": "tool_execution_started", "name": "delegate", "input": {"background": True}, "executionId": "ex-6", "invocationSeq": 5}),
            (5, {"type": "tool_execution_started", "name": "shell", "input": {"command": "sleep 30; cat " + s + "/x.tasks/t1/output.log"}, "executionId": "ex-7"}),
            (6, {"type": "tool_execution_started", "name": "read_file", "input": {"path": s + "/x.tasks/t2/output.log"}, "executionId": "ex-8"}),
            (7, {"type": "stop", "reason": "end_turn"}),
            (8, {"type": "terminal", "outcome": {"kind": "completed"}}),
        ] + notices)
        for tid in ("t1", "t2"):
            write_journal(s, "x", tid, [{"type": "planned", "ts": 4, "backend": "process", "executionId": "ex-6", "agent": {"role": "explorer", "session": "sub-" + tid}}] + ([{"type": "terminal", "ts": 20}] if child_terminal or tid == "t1" else []))
            write_jsonl(os.path.join(s, "sub-" + tid + ".jsonl"), [{"type": "stop"}] * (2 if tid == "t1" else 5))
        return counted(tmp)

    def test_f1b_one_group_one_delivery_its_wake_and_the_polls(self):
        group = {"type": "user_input", "source": "system", "content": "<kiso-task/>", "via": {"kind": "tasks", "items": [{"taskId": "t1", "transition": "exited"}, {"taskId": "t2", "transition": "exited"}]}}
        with tempfile.TemporaryDirectory() as tmp:
            c = self.f1b_leg(tmp, [(30, group), (31, {"type": "stop", "reason": "tool_use"}), (32, {"type": "stop", "reason": "end_turn"}), (33, {"type": "terminal", "outcome": {"kind": "completed"}})])
            self.assertEqual((c["groups"]["count"], c["groups"]["members"], c["groups"]["deliveries"], c["groups"]["deliveredOnce"]), (1, [2], 1, True))
            self.assertEqual((c["children"]["count"], c["children"]["requests"], c["children"]["leftRunning"]), (2, [2, 5], 0))
            self.assertEqual((c["wakes"], c["wakeRequests"]), (1, [2]))
            self.assertEqual((c["sleepCalls"], c["outputPolls"]), (1, 2))

    def test_f1b_a_child_named_twice_or_left_running_is_seen(self):
        twice = [(30, notice("t1", "exited")), (31, {"type": "user_input", "source": "system", "content": "<kiso-task/>", "via": {"kind": "tasks", "items": [{"taskId": "t1", "transition": "exited"}, {"taskId": "t2", "transition": "exited"}]}})]
        with tempfile.TemporaryDirectory() as tmp:
            c = self.f1b_leg(tmp, twice)
            self.assertEqual((c["groups"]["deliveries"], c["groups"]["deliveredOnce"]), (2, False))
        with tempfile.TemporaryDirectory() as tmp:
            c = self.f1b_leg(tmp, [(30, notice("t1", "exited"))], child_terminal=False)
            self.assertEqual((c["children"]["leftRunning"], c["groups"]["deliveredOnce"]), (1, False))


class Gates0460b(unittest.TestCase):
    def gate(self, root):
        r = subprocess.run(["node", os.path.join(B, "gates-0460b.mjs"), root], capture_output=True, text=True, cwd=B)
        return r.returncode, json.loads(r.stdout)

    def l2_leg(self, root, run, post_final):
        w = os.path.join(root, "kiso-L2-" + run)
        events = [{"type": "user_input", "content": "go"}, {"type": "stop", "reason": "end_turn"}]
        if post_final:
            events += [notice("t2", "stopped"), {"type": "stop", "reason": "end_turn"}]
        write_jsonl(os.path.join(w, "kiso-home", "sessions", "bench-L2-" + run + ".jsonl"), events + [{"type": "terminal", "outcome": {"kind": "completed"}}])
        with open(os.path.join(w, "verify"), "w") as f:
            f.write("pass\n")
        return w

    def test_an_acknowledgement_after_the_final_answer_blocks_l2_and_a_void_leg_is_not_read(self):
        with tempfile.TemporaryDirectory() as root:
            self.l2_leg(root, "rc1", False)
            code, g = self.gate(root)
            self.assertEqual((code, g["verdict"]), (0, "PASS"), g)
            self.l2_leg(root, "rc2", True)
            code, g = self.gate(root)
            self.assertEqual((code, g["verdict"]), (1, "BLOCK"), g)
            with open(os.path.join(root, "kiso-L2-rc2", "void"), "w") as f:
                f.write("VOID: test\n")
            self.assertEqual(self.gate(root)[0], 0)

    def test_an_f1b_probe_that_never_fanned_out_did_not_measure(self):
        with tempfile.TemporaryDirectory() as root:
            for i in range(1, 7):
                w = os.path.join(root, f"kiso-F1b-rc{i}")
                write_jsonl(os.path.join(w, "kiso-home", "sessions", f"bench-F1b-rc{i}.jsonl"), [{"type": "user_input"}, {"type": "stop", "reason": "end_turn"}, {"type": "terminal", "outcome": {"kind": "completed"}}])
                with open(os.path.join(w, "verify"), "w") as f:
                    f.write("pass\n")
            code, g = self.gate(root)
            self.assertEqual((code, g["verdict"]), (2, "NOT MEASURED"), g)
            self.assertIn("0 of 6 legs fanned out", g["instrument"][0])


FAKE_KISO = textwrap.dedent(r"""
    #!/usr/bin/env node
    // a fake kiso: answers --version; otherwise one run per stdin line, then exits at stdin's end
    const fs = require("fs"), path = require("path");
    if (process.argv[2] === "--version") { console.log("9.9.9"); process.exit(0); }
    const sid = process.argv[process.argv.length - 1];
    const dir = process.env.KISO_SESSIONS_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, sid + ".jsonl");
    const w = (event) => fs.appendFileSync(log, JSON.stringify({ runId: "r", ts: Date.now(), event }) + "\n");
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        w({ type: "user_input", content: line });
        w({ type: "stop", reason: "end_turn" });
        w({ type: "usage", inputTokens: 100, cacheRead: 50, outputTokens: 5 });
        w({ type: "text_delta", text: "1) 25 / 200 2) ABC-1234 3) 404 and 204 4) INVENTORY_DB, data/inventory.db 5) 4 attempts, 150 ms then 300 ms 6) src/reports/summary.js" });
        w({ type: "terminal", outcome: { kind: "completed" } });
      }
    });
    process.stdin.on("end", () => { fs.writeFileSync(path.join(dir, "..", "stdin-closed-at"), String(Date.now())); process.exit(0); });
""").lstrip()


def fake_env(tmp):
    """PATH with the fake kiso first, a fake DeepSeek credential, and fast leg settings."""
    bindir = os.path.join(tmp, "bin"); os.makedirs(bindir)
    fake = os.path.join(bindir, "kiso")
    with open(fake, "w") as f:
        f.write(FAKE_KISO)
    os.chmod(fake, 0o755)
    cfg = os.path.join(tmp, "cfg", "claude-deepseek"); os.makedirs(cfg)
    with open(os.path.join(cfg, "credentials.env"), "w") as f:
        f.write("DEEPSEEK_API_KEY=not-a-key\n")
    env = dict(os.environ, PATH=bindir + os.pathsep + os.environ["PATH"], XDG_CONFIG_HOME=os.path.join(tmp, "cfg"),
               KISO_RUNS_ROOT=os.path.join(tmp, "runs"), KISO_ROUND="e2e", BENCH_EFFORT="none", FEED_QUIET_MS="300",
               KISO_LEG_DEADLINE_S="60", KISO_BIN="kiso")
    env.pop("KISO_VERSION", None)
    return env


class RunProbeEndToEnd(unittest.TestCase):
    def test_f1b_runs_rc_only_and_a_leg_of_the_wrong_build_is_void(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            env = dict(fake_env(tmp), KISO_BIN_RC="kiso", RC_VERSION="9.9.9")
            r = subprocess.run(["sh", os.path.join(B, "run-probe.sh"), "F1b", "1"], capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            w = os.path.join(tmp, "runs", "e2e", "kiso-F1b-rc1")
            self.assertEqual(read(os.path.join(w, "verify")).strip(), "pass")
            self.assertEqual(json.loads(read(os.path.join(w, "meta.json")))["task"], "F1b")
            self.assertFalse(os.path.exists(os.path.join(w, "void")))
            self.assertFalse(any("ctl" in d for d in os.listdir(os.path.join(tmp, "runs", "e2e"))), "the probe ran a control arm")
            r = subprocess.run(["sh", os.path.join(B, "run-probe.sh"), "F1b", "1"], capture_output=True, text=True, env=dict(env, RC_VERSION="1.0.0"), timeout=120)
            self.assertIn("void legs (version): 1", r.stdout)
            self.assertTrue(os.path.exists(os.path.join(w, "void")))


class RunTaskEndToEnd(unittest.TestCase):
    def test_f1b_is_f1s_fixture_with_the_fan_out_asked_for(self):
        tasks = json.loads(read(os.path.join(B, "tasks-0460.json")))
        self.assertTrue(tasks["F1b"].startswith(tasks["F1"]))
        self.assertIn("background: true", tasks["F1b"])
        self.assertIn("Do not sleep or poll", tasks["F1b"])

    def test_a_leg_runs_closes_stdin_when_idle_and_writes_every_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            env = fake_env(tmp)
            t0 = time.time()
            r = subprocess.run(["sh", os.path.join(B, "run-task.sh"), "F1", "e1"], capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            w = os.path.join(tmp, "runs", "e2e", "kiso-F1-e1")
            for rec in ["meta.json", "wall_seconds", "exit", "status", "verify", "counters.json"]:
                self.assertTrue(os.path.exists(os.path.join(w, rec)), rec)
            self.assertEqual(read(os.path.join(w, "status")).strip(), "complete")
            self.assertEqual(read(os.path.join(w, "verify")).strip(), "pass")
            meta = json.loads(read(os.path.join(w, "meta.json")))
            self.assertEqual((meta["kisoVersion"], meta["route"], meta["task"]), ("9.9.9", "ds", "F1"))
            # the feeder held stdin until the session was idle, then closed it
            self.assertTrue(os.path.exists(os.path.join(w, "kiso-home", "stdin-closed-at")))
            self.assertLess(time.time() - t0, 60)


if __name__ == "__main__":
    unittest.main()
