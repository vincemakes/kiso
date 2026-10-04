"""The 0.46.0 evaluation's bench pieces (kiso-doc plan-0460-3f-evaluation):
the per-leg counters, the route trial gate, the feeder's idle rule, the
paired-row split, the round spend, the F1 marks — and run-task.sh end to
end against a fake kiso, which proves the feeder keeps stdin open until the
session is idle and the leg writes every record it promises.

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


class RunTaskEndToEnd(unittest.TestCase):
    def test_a_leg_runs_closes_stdin_when_idle_and_writes_every_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
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
