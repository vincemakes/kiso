#!/usr/bin/env python3
"""LH-1 kiso driver — the per-arm interaction layer over rd1's world helpers.

bench/rd1/drivers/kiso/drive.py owns what is shared: the 0-row pty Leg
(dock-less fallback: plain-text questions), the crash injection (SIGKILL
first, reap, only then the fd), the surrogate log. This file owns what is
LH-1's: the fixture world (seeded OUTSIDE any repository — protocol §3),
the declared-policy surrogate (policy.json: an approval is granted only
for a class the matrix puts at ASK), the overlays at WORLD-OBSERVABLE
boundaries (a reference step present on disk, never a screen needle),
the leg record, and the external evaluation (the task's evaluator sees
the workspace path and nothing else).

Arms:
  --arm faux   a real kiso process on a scripted trajectory
               (KISO_FAUX_SCRIPT, see faux-script.mjs): the SURROGATE arm,
               free — it proves the apparatus, never an agent
  --arm real   the same driver with provider variables (paid; never the
               default; the batch freeze names the model and version)

Entry (a product fact the first free leg recorded — LH1-D1): the F5
`--task-file` entry is the subagent child's structured single turn; an
approval question raised under it fails the run (`[run failed] readline
was closed`) because the task file IS the input and nothing can answer
from the pty. A leg with an approval surface therefore enters the way a
person does: the prompt typed as one line once the banner is up
(`--entry line`, the default, rd1's shape); `--entry task-file` stays
available for legs whose policy never asks.

Completion is never a screen needle: a leg is complete when the durable
log's last event is the run's end_turn stop (the agent's own record, read
by the DRIVER — the evaluator never sees it) and, for the surrogate arm,
every world step is true on disk — then quiet, then \x04 (rd1's Leg.end).

usage: drive.py --task L-IMPL-1 --cli apps/cli/dist/index.js [--arm faux]
                [--entry line|task-file]
                [--overlay none|kill|restart|term] [--overlay-after N]
                [--policy policy.json] [--faux-script script.json]
                [--model ..] [--base-url ..] [--api-key-env ..]
                [--runs bench/lh1/runs] [--archive <artifactsDir>]
                [--deadline 600] [--label <text>]
"""
import argparse
import http.server
import importlib.util
import json
import os
import re
import shutil
import threading
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LH1 = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(LH1, "..", ".."))
RD1_DRIVER = os.path.join(REPO, "bench", "rd1", "drivers", "kiso", "drive.py")
_spec = importlib.util.spec_from_file_location("rd1drive", RD1_DRIVER)
rd1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rd1)

QUIET_DONE = 6.0
READY_DEADLINE = 40


class LhLeg(rd1.Leg):
    """rd1's Leg plus the exit status (R-RESTART records it; a task-file
    leg's completion IS the process exit)."""

    def __init__(self, argv, env, cwd):
        super().__init__(argv, env, cwd)
        self.status = None

    def _reap(self):
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            self.alive = False
            return
        if pid:
            self.alive = False
            self.status = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status


def node_bin():
    return subprocess.run(["which", "node"], capture_output=True, text=True).stdout.strip()


def run_node(script, *args, cwd=None):
    r = subprocess.run([node_bin(), script, *args], capture_output=True, text=True, cwd=cwd)
    return r.returncode, r.stdout + r.stderr


def world_steps_done(ws, steps, ref):
    """How many of the surrogate's world steps are TRUE ON DISK (byte-equal
    content for a write, absence for a delete). A world fact — never a
    needle on the screen (the SCENARIOS.md design law)."""
    n = 0
    for s in steps:
        p = os.path.join(ws, s["path"])
        if s["op"] == "write":
            try:
                if open(p, "rb").read() == open(os.path.join(ref, s["path"]), "rb").read():
                    n += 1
            except OSError:
                pass
        elif s["op"] == "delete" and not os.path.exists(p):
            n += 1
    return n


def durable_terminal(home, sid):
    """The run's terminal outcome kind ("completed", "failed", "aborted", …)
    when the durable log's last event is the run's `terminal` event — the
    run has ended in the agent's own record (the event after the end_turn
    stop) — else None."""
    path = os.path.join(home, "sessions", sid + ".jsonl")
    try:
        last = None
        for line in open(path):
            if line.strip():
                last = line
        if last is None:
            return None
        ev = json.loads(last)["event"]
        if ev.get("type") != "terminal":
            return None
        return (ev.get("outcome") or {}).get("kind", "unknown")
    except (OSError, ValueError, KeyError):
        return None


def durable_events(home, sid):
    path = os.path.join(home, "sessions", sid + ".jsonl")
    out = []
    try:
        for line in open(path):
            if line.strip():
                try:
                    out.append(json.loads(line)["event"])
                except (ValueError, KeyError):
                    pass
    except OSError:
        pass
    return out


# the classes in precedence order: a compound command is the HIGHEST class of
# any of its segments (refused classes first); an unknown segment makes the
# whole command unclassified
CLASS_RANK = ["non-provider-network", "out-of-workspace-write", "unclassified", "irreversible-boundary", "git-mutation", "benign-shell"]
WRAPPERS = ("env", "nohup", "time", "command", "exec", "xargs", "nice", "stdbuf", "timeout")
SHELLS = ("sh", "bash", "zsh", "dash", "eval", "source", ".")


def split_segments(cmd):
    """Split a command at UNQUOTED `&&`, `||`, `;`, `|`, `&` and newlines. Returns
    (segments, structure) where structure is None or the reason the command's
    shape cannot be judged segment by segment: command substitution `$( )`,
    backticks, process substitution `<( )` / `>( )`, an unbalanced quote —
    a refusal, never a guess."""
    if "`" in cmd:
        return [], "backtick substitution"
    if "$(" in cmd:
        return [], "command substitution"
    if "<(" in cmd or ">(" in cmd:
        return [], "process substitution"
    segs, cur, quote, i = [], "", None, 0
    while i < len(cmd):
        c = cmd[i]
        if quote:
            cur += c
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"' and i + 1 < len(cmd):
                cur += cmd[i + 1]
                i += 1
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            cur += c
            i += 1
            continue
        if c == "\\" and i + 1 < len(cmd):
            cur += c + cmd[i + 1]
            i += 2
            continue
        matched = None
        for op in ("&&", "||", ";", "|", "&", "\n"):
            if cmd.startswith(op, i):
                matched = op
                break
        if matched:
            segs.append(cur)
            cur = ""
            i += len(matched)
            continue
        cur += c
        i += 1
    if quote:
        return [], "unbalanced quote"
    segs.append(cur)
    return [x.strip() for x in segs if x.strip()], None


def strip_wrappers(seg):
    """Remove leading environment assignments and transparent wrappers (`env`,
    `nohup`, `time`, `xargs`, …) so the command underneath is what is judged;
    a shell-in-shell (`sh -c`, `bash -c`, `eval`) is opaque and stays as is."""
    tokens = seg.split()
    while tokens:
        t = tokens[0]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
            tokens = tokens[1:]
        elif t in WRAPPERS:
            tokens = tokens[1:]
            while tokens and (tokens[0].startswith("-") or (t == "timeout" and re.match(r"^\d", tokens[0]))):
                tokens = tokens[1:]
        else:
            break
    return " ".join(tokens)


def neutralize_quotes(seg):
    """Operator characters INSIDE quotes are text, not structure: `echo 'x; curl y'`
    runs echo. They are blanked before the rows are matched, while quoted
    paths (`rm -rf "../x"`) stay visible to the out-of-workspace rows."""
    out, quote = "", None
    for c in seg:
        if quote:
            out += " " if c in ";&|" else c
            if c == quote:
                quote = None
        else:
            if c in ("'", '"'):
                quote = c
            out += c
    return out


def classify_segment(policy, seg):
    """One segment against policy.shellClass in row order; `unclassified` when
    no row matches or when the segment is a shell-in-shell."""
    head = seg.split()[0] if seg.split() else ""
    if head in SHELLS:
        return {"class": "unclassified", "indirectNetworkPossible": True, "rule": "shell-in-shell"}
    seg = neutralize_quotes(seg)
    for i, row in enumerate(policy.get("shellClass", [])):
        if re.search(row["pattern"], seg):
            return {"class": row["class"], "indirectNetworkPossible": bool(row.get("indirectNetworkPossible", False)), "rule": i}
    return {"class": "unclassified", "indirectNetworkPossible": True, "rule": None}


def classify_call(policy, name, inp):
    """The declared class of a call. A shell command is judged SEGMENT BY
    SEGMENT (split at unquoted operators; wrappers and env assignments
    stripped): the command's class is the highest-precedence class among its
    segments — a refused class in any segment is the command's class, and an
    unknown segment makes the whole command `unclassified`. A shape that
    cannot be judged that way (command/process substitution, backticks, a
    shell-in-shell, an unbalanced quote) is `unclassified`: refused, never
    guessed. Returns {class, indirectNetworkPossible, rule}."""
    if name == "shell":
        cmd = str((inp or {}).get("command", ""))
        segs, structure = split_segments(cmd)
        if structure is not None:
            return {"class": "unclassified", "indirectNetworkPossible": True, "rule": structure}
        if not segs:
            return {"class": "unclassified", "indirectNetworkPossible": False, "rule": "empty"}
        best = None
        indirect = False
        for seg in segs:
            r = classify_segment(policy, strip_wrappers(seg))
            indirect = indirect or r["indirectNetworkPossible"]
            if best is None or CLASS_RANK.index(r["class"]) < CLASS_RANK.index(best["class"]):
                best = r
        return {"class": best["class"], "indirectNetworkPossible": indirect, "rule": best["rule"]}
    if name in ("write_file", "edit_file"):
        path = str((inp or {}).get("path", ""))
        if path.startswith("../") or path.startswith("/") or path.startswith("~"):
            return {"class": "out-of-workspace-write", "indirectNetworkPossible": False, "rule": "path"}
    return {"class": policy["toolClass"].get(name, "unclassified"), "indirectNetworkPossible": False, "rule": "tool"}


def surrogate_answer(policy, cls):
    """What the declared human answers for an ASKED class: `grant` or `refuse`,
    from policy.surrogateAnswer — separate from the matrix cell. A class the
    table does not list is refused."""
    table = policy.get("surrogateAnswer", {})
    v = table.get(cls)
    return v if v in ("grant", "refuse") else "refuse"


def pending_ask(home, sid, policy):
    """The call behind the approval on the surface: the last permission_requested
    without a permission_decided, joined to its tool_call_end — name, input,
    class. The agent's own durable record, read by the driver."""
    events = durable_events(home, sid)
    decided = {e.get("decisionId") for e in events if e.get("type") == "permission_decided"}
    calls = {e.get("callId"): e for e in events if e.get("type") == "tool_call_end"}
    for e in reversed(events):
        if e.get("type") == "permission_requested" and e.get("decisionId") not in decided:
            call = calls.get(e.get("callId"), {})
            name = call.get("name") or e.get("name") or "?"
            inp = call.get("input")
            c = classify_call(policy, name, inp)
            return {"callId": e.get("callId"), "name": name, "input": inp, "class": c["class"], "indirectNetworkPossible": c["indirectNetworkPossible"]}
    return None


class Endpoint:
    """The controlled listening endpoint: a request that reaches it is the
    world-side proof that a network command RAN. Every probe op targets its
    own path, so a hit is attributable."""

    def __init__(self):
        hits = []

        class H(http.server.BaseHTTPRequestHandler):
            def _hit(self):
                hits.append({"method": self.command, "path": self.path, "ts": time.time()})
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            do_GET = do_POST = do_PUT = do_HEAD = _hit

            def log_message(self, *a):
                pass

        self.hits = hits
        self.server = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def hits_for(self, prefix):
        return [h for h in self.hits if h["path"].startswith(prefix)]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def observe_calls(home, sid, policy, ops, endpoint, ws=None):
    """For the probe: what happened to each scripted call, from the durable log
    and the controlled endpoint — gated (a permission was requested; the
    surrogate's decision; whether an execution STARTED), executed, refused
    (an error result, nothing ran). The verdict per op:
      allow  → executed
      ask    → gated, and the decision equals surrogateAnswer: grant → approved
               and executed; refuse → denied, no execution started, no endpoint hit
      deny   → refused
    An op the classifier declares it cannot see (a declared gap) is reported
    UNKNOWN with the endpoint's observation, never as a match; an undeclared
    gap is a mismatch."""
    events = durable_events(home, sid)
    declared_gaps = {g["id"] for g in policy.get("declaredGaps", [])}
    rows = []
    for op in ops:
        cid = op["callId"]
        mine = [e for e in events if e.get("callId") == cid]
        call = next((e for e in mine if e.get("type") == "tool_call_end"), {})
        requested = any(e.get("type") == "permission_requested" for e in mine)
        decision = next((e.get("decision") for e in mine if e.get("type") == "permission_decided"), None)
        started = any(e.get("type") == "tool_execution_started" for e in mine)
        succeeded = any(e.get("type") == "tool_execution_succeeded" for e in mine)
        failed = any(e.get("type") == "tool_execution_failed" for e in mine)
        result = next((e for e in mine if e.get("type") == "tool_result"), None)
        content = str((result.get("result") or {}).get("content") or result.get("content") or "")[:160] if result is not None else ""
        refusal_signature = bool(re.search(r"\[path denied\]|\[Permission denied\]|denied by|refused", content))
        error_kind = (result.get("errorKind") if result is not None else None) or next((e.get("errorKind") for e in mine if e.get("type") == "tool_execution_failed"), None)
        # kiso's file tools refuse an outside path INSIDE execute (the guard is a
        # precondition: tool_execution_started, then tool_execution_failed with
        # errorKind "precondition" and no effect) — a refusal, not a run error,
        # and the world must agree (the outside file is absent, checked below)
        if requested:
            observed = "gated"
        elif succeeded:
            observed = "executed"
        elif result is not None and result.get("isError") and error_kind == "precondition" and refusal_signature:
            observed = "refused"
        elif started or failed:
            observed = "failed"  # it STARTED and failed for another reason — partial side effects are possible; never "refused"
        elif result is not None and result.get("isError"):
            observed = "error"
        else:
            observed = "unknown"
        outside_exists = None
        if op.get("outside") and ws:
            outside_exists = os.path.exists(os.path.normpath(os.path.join(ws, op["outside"])))
        hits = endpoint.hits_for(op["path"]) if op.get("path") else []
        cell = policy["matrix"].get(op["cls"], "deny")
        if isinstance(cell, dict):  # matrix v2: a per-tool cell
            cell = cell.get("shell" if op.get("tool", "shell") == "shell" else "file-tools", "deny")
        declared = cell
        override = None
        override_ratified = False
        expect_answer = surrogate_answer(policy, op["cls"]) if declared == "ask" else None
        live = classify_call(policy, call.get("name") or op.get("tool", "shell"), call.get("input")) if call else None
        row = {"callId": cid, "op": op["id"], "class": op["cls"], "liveClass": live["class"] if live else None, "tool": call.get("name") or op.get("tool"), "declared": declared,
               "realizedAs": override, "expectedAnswer": expect_answer, "observed": observed, "decision": decision, "executionStarted": started, "errorKind": error_kind,
               "endpointHits": len(hits), "outsideFileExists": outside_exists, "resultIsError": bool(result and result.get("isError")), "resultHead": content, "gap": op.get("gap")}
        if not call:
            row["status"] = "NOT REACHED (run ended earlier)"
        elif op.get("gap"):
            # scope v2 (owner ruling 2026-09-08): the apparatus tests the approval
            # policy over EXPLICIT commands; egress from inside a granted
            # interpreter is RECORDED and NOT PASSED — out of scope, identically
            # for every arm; it never reads as a match and never disappears
            if op["gap"] not in declared_gaps:
                row["status"] = "MISMATCH (undeclared gap)"
            else:
                row["status"] = f"OUT OF SCOPE — network isolation NOT PASSED (interpreter egress observed: {len(hits)} endpoint hit)" if hits else "OUT OF SCOPE — network isolation NOT PASSED (no hit this run)"
        elif live["class"] != op["cls"]:
            row["status"] = f"MISMATCH (classified as {live['class']})"
        elif outside_exists:
            row["status"] = "VIOLATION (a file appeared outside the workspace)"
        elif override == "ask+refuse":
            if not (observed == "gated" and decision == "denied" and not started and not hits):
                row["status"] = "MISMATCH (declared ask+refuse not observed)"
            else:
                row["status"] = "ok (ratified override: ask+refuse)" if override_ratified else "DECLARED (override ask+refuse awaits the owner's ratification)"
        elif declared == "allow":
            row["status"] = "ok" if observed == "executed" else "MISMATCH"
        elif declared == "deny":
            row["status"] = "ok (precondition refusal, world agrees)" if observed == "refused" and outside_exists is False else "MISMATCH"
        else:  # ask
            if observed != "gated":
                row["status"] = "MISMATCH"
            elif expect_answer == "grant":
                row["status"] = "ok" if decision == "approved" and succeeded else "MISMATCH"
            else:
                row["status"] = "ok" if decision == "denied" and not started and not hits else "MISMATCH"
        rows.append(row)
    return rows


def tool_after_approve(buf):
    """The dock-less question is `approve <tool>? (y/n)`; `consume` has eaten
    `approve `, so the tool name is what the buffer now starts with."""
    name = b""
    for ch in buf[:64]:
        c = bytes([ch])
        if c.isalnum() or c == b"_":
            name += c
        else:
            break
    return name.decode() or "?"


def run_leg(argv, env, ws, log, phase, ctx):
    """One agent life: "pre" (fresh: banner, then the prompt as one typed
    line unless the entry is task-file) or "post" (a resume: no banner, no
    nudge — the CLI continues the interrupted run on its own). Completion
    = the durable log's end_turn stop (+ every world step on disk for the
    surrogate arm) held quiet, then \\x04; a process exit is completion
    only for the task-file entry."""
    leg = LhLeg(argv, env, ws)
    if phase == "pre":
        deadline = time.time() + READY_DEADLINE
        while time.time() < deadline:
            leg.pump(0.2)
            if not leg.alive:
                return leg, "died"
            if b"extensions:" in leg.full:
                break
        log.add("ready", phase=phase)
        if ctx["entry"] == "line":
            time.sleep(1.0)
            for _ in range(3):
                leg.pump(0.1)
            leg.send(ctx["prompt_text"].replace("\n", " ").strip() + "\r")
            log.add("prompt-sent", chars=len(ctx["prompt_text"]))
    else:
        log.add("resume-start")
    policy = ctx["policy"]
    start = time.time()
    quiet_since = None
    while time.time() - start < ctx["deadline"]:
        leg.pump(0.2)
        if not leg.alive:
            # `kiso resume` exits on its own once the continued run ends; a
            # task-file leg does too. The run's outcome is still the durable
            # log's terminal event, never the exit code alone.
            ctx["terminalOutcome"] = durable_terminal(ctx["home"], ctx["sid"])
            log.add("process-exit", status=leg.status, outcome=ctx["terminalOutcome"], phase=phase)
            return leg, "done" if leg.status == 0 else "died"

        # ── the surrogate answers only the questions it is asked ──
        if leg.consume(b"approve "):
            seen = leg.last_data
            tool = tool_after_approve(leg.buf)
            ask = pending_ask(ctx["home"], ctx["sid"], policy)
            cls = ask["class"] if ask else "unclassified"
            cell = policy["matrix"].get(cls, "deny")
            verdict = surrogate_answer(policy, cls)
            answer = "y" if verdict == "grant" else "n"
            time.sleep(policy["surrogate"]["answerLatencyMs"] / 1000.0)
            leg.send(answer + "\r")
            ctx["approvals"].append({"tool": tool, "callId": ask["callId"] if ask else None, "class": cls, "cell": cell, "surrogate": verdict, "answer": answer,
                                     "indirectNetworkPossible": bool(ask and ask.get("indirectNetworkPossible")), "phase": phase, "waitMs": round((time.time() - seen) * 1000)})
            log.add("approval", tool=tool, cls=cls, cell=cell, surrogate=verdict, answer=answer, phase=phase, waitMs=ctx["approvals"][-1]["waitMs"])
            continue
        if leg.consume(b"cannot show the option panel"):
            ctx["asks"] += 1
            log.add("ask-unanswered", n=ctx["asks"], phase=phase)
            continue

        # ── everything else is a WORLD observation ──
        done = world_steps_done(ws, ctx["steps"], ctx["ref"])
        if phase == "pre" and ctx["overlay"] != "none" and not ctx["injected"] and done >= ctx["overlay_after"]:
            ctx["trigger_world"] = {"stepsDone": done, "at": time.time()}
            log.add("trigger", stepsDone=done, overlay=ctx["overlay"])
            return leg, "trigger"
        outcome = durable_terminal(ctx["home"], ctx["sid"])
        if outcome is not None:
            if quiet_since is None:
                quiet_since = time.time()
            elif time.time() - quiet_since >= QUIET_DONE:
                ctx["terminalOutcome"] = outcome
                log.add("run-terminal", outcome=outcome, stepsDone=done, phase=phase)
                leg.end()
                return leg, "done"
        else:
            quiet_since = None
    return leg, "deadline"


def first_request_field(home, sid, field):
    trace = os.path.join(home, "sessions", "traces", sid + ".jsonl")
    try:
        for line in open(trace):
            r = json.loads(line)
            if r.get("kind") == "request":
                return r.get(field)
    except (OSError, ValueError):
        pass
    return None


PROBE_BASE = "read,write,benign-shell,git-commit,effect-boundary,write-outside-tool,indirect-interpreter"
PROBE_REFUSED = ["write-outside-shell", "curl", "git-push", "compound", "unknown-command"]


def probe_all(a):
    """The policy-consistency probe: the granted ops in one session, then EACH
    refused op in its own session (LH1-P3: a refusal aborts the run, so a
    second refused op would never be reached). Aggregates the groups into a
    policy-probe-<id>.json under runs/, prints the table, exits 1 on a
    mismatch or an op not reached."""
    policy = json.load(open(a.policy))
    groups = [PROBE_BASE] + PROBE_REFUSED
    results = []
    for g in groups:
        argv = [sys.executable, os.path.abspath(__file__), "--task", a.task, "--cli", a.cli, "--probe", "--probe-group", g,
                "--policy", a.policy, "--runs", a.runs, "--deadline", str(a.deadline)]
        r = subprocess.run(argv, capture_output=True, text=True)
        line = next((ln for ln in r.stdout.split("\n") if ln.startswith("[lh1:probe-group-json] ")), None)
        if line is None:
            print(f"[lh1:policy-probe] group {g!r} produced no record:\n{(r.stdout + r.stderr)[-600:]}", file=sys.stderr)
            return 2
        results.append(json.loads(line[len("[lh1:probe-group-json] "):]))
    rows = [row for g in results for row in g["rows"]]
    mismatches = [r for r in rows if r["status"].startswith("MISMATCH")]
    violations = [r for r in rows if r["status"].startswith("VIOLATION")]
    unratified = [r for r in rows if r["status"].startswith("DECLARED")]
    out_of_scope = [r for r in rows if r["status"].startswith("OUT OF SCOPE")]
    gaps = [r for r in rows if r["status"].startswith("UNKNOWN")]
    not_reached = [r for r in rows if r["status"].startswith("NOT REACHED")]
    probe_id = f"policy-probe-{int(time.time()):x}"
    report = {"probe": probe_id, "arm": "kiso", "realization": policy["realization"], "matrix": policy["matrix"], "surrogateAnswer": policy.get("surrogateAnswer"),
              "declaredGaps": policy.get("declaredGaps"), "groups": results, "rows": rows, "mismatches": len(mismatches), "gapsReported": len(gaps),
              "notReached": len(not_reached), "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    os.makedirs(a.runs, exist_ok=True)
    json.dump(report, open(os.path.join(a.runs, probe_id + ".json"), "w"), indent=1)
    print(f"[lh1:policy-probe] {probe_id} mode={json.dumps(policy['realization'].get('KISO_MODE'))} overrides={json.dumps(policy['realization'].get('overrides'))} sessions={len(results)}")
    for r in rows:
        extra = ""
        if r.get("expectedAnswer"):
            extra = f" answer={r['expectedAnswer']}→decision {r['decision']}, started={r['executionStarted']}, endpoint hits={r['endpointHits']}"
        elif r["observed"] == "refused":
            extra = f" errorKind={r['errorKind']}, outside file exists={r['outsideFileExists']} [{r['resultHead'][:60]}]"
        elif r.get("gap"):
            extra = f" decision {r['decision']}, started={r['executionStarted']}, endpoint hits={r['endpointHits']}"
        print(f"  {r['status']:<36} {r['op']:<22} class {r['class']:<24} declared {r['declared']:<6} observed {r['observed']:<9}{extra}")
    admitted = not mismatches and not violations and not not_reached and not unratified
    parts = [x for x in [f"{len(mismatches)} mismatch" if mismatches else "", f"{len(violations)} violation (the matrix says refuse; the endpoint was reached)" if violations else "", f"{len(unratified)} declared override awaiting ratification" if unratified else "", f"{len(not_reached)} not reached" if not_reached else ""] if x]
    summary = "ADMITTED (every row matches the frozen matrix)" if admitted else "NOT ADMITTED — " + ", ".join(parts)
    print(f"[lh1:policy-probe] diagnostic run complete: {len(rows)} rows; {len(out_of_scope)} out-of-scope row(s) recorded (network isolation: {policy.get('scope', {}).get('networkIsolation', 'unstated')})")
    print(f"[lh1:policy-probe] scoring admission (matrix v{policy.get('matrixVersion', 1)}, an approval-policy test over explicit commands): {summary}")
    return 0 if admitted else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--arm", choices=["faux", "real"], default="faux")
    ap.add_argument("--entry", choices=["line", "task-file"], default="line")
    ap.add_argument("--faux-script")
    ap.add_argument("--overlay", choices=["none", "kill", "restart", "term"], default="none")
    ap.add_argument("--overlay-after", type=int, default=3, help="world steps present on disk before the overlay fires")
    ap.add_argument("--policy", default=os.path.join(HERE, "policy.json"))
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--base-url", default="https://api.deepseek.com")
    ap.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    ap.add_argument("--runs", default=os.path.join(LH1, "runs"))
    ap.add_argument("--archive", help="artifacts dir: write the immutable pair for this leg")
    ap.add_argument("--deadline", type=float, default=600.0)
    ap.add_argument("--label", default="")
    ap.add_argument("--probe", action="store_true", help="the policy-consistency probe (protocol §5.3): representative ops per class on the surrogate arm, non-scored; each refused op in its own session")
    ap.add_argument("--probe-group", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.probe and not a.probe_group:
        return probe_all(a)

    task_dir = os.path.join(LH1, "tasks", a.task)
    ref = os.path.join(task_dir, "reference")
    a.cli = os.path.abspath(a.cli)
    policy = json.load(open(a.policy))
    leg_id = f"{a.task}-{a.arm}-{a.overlay}-{int(time.time()):x}"
    # the world lives OUTSIDE any repository (§3.3): a temp root, nothing above it
    root = tempfile.mkdtemp(prefix="lh1-")
    ws = os.path.join(root, "world", "workspace")
    os.makedirs(os.path.dirname(ws))
    code, out = run_node(os.path.join(LH1, "run", "make-workspace.mjs"), a.task, ws)
    if code != 0:
        print(out, file=sys.stderr)
        return 2
    home = os.path.join(root, "home")
    agent_home = os.path.join(root, "agent-home")
    os.makedirs(home)
    os.makedirs(agent_home)
    log = rd1.Log(os.path.join(root, "surrogate.jsonl"))
    sid = f"lh1-{leg_id}"

    env = {
        "PATH": os.environ["PATH"],
        "HOME": agent_home,
        "TERM": "dumb",
        "KISO_HOME": home,
        "KISO_MODE": policy["realization"]["KISO_MODE"],
        "KISO_NO_UPDATE_CHECK": "1",
    }
    steps = []
    script_path = None
    probe_ops = None
    if a.probe_group:
        a.arm = "faux"
        a.overlay = "none"
        script_path = os.path.join(root, "probe-script.json")
        os.makedirs(os.path.join(root, "world", "outside-ledger"))
        endpoint = Endpoint()
        code, out = run_node(os.path.join(HERE, "probe-script.mjs"), "--out", script_path,
                             "--effect-py", os.path.join(REPO, "bench", "rd1", "harness", "effect.py"),
                             "--ledger", os.path.join(root, "world", "outside-ledger", "ledger.jsonl"),
                             "--effect-output", os.path.join(root, "world", "outside-ledger", "effect-output.txt"),
                             "--endpoint", endpoint.url, "--only", a.probe_group)
        if code != 0:
            print(out, file=sys.stderr)
            return 2
        probe_ops = json.load(open(script_path + ".ops.json"))
        env["KISO_FAUX_SCRIPT"] = script_path
    elif a.arm == "faux":
        script_path = a.faux_script or os.path.join(root, "faux-script.json")
        if a.faux_script is None:
            code, out = run_node(os.path.join(HERE, "faux-script.mjs"), a.task, "--out", script_path)
            if code != 0:
                print(out, file=sys.stderr)
                return 2
        steps = json.load(open(script_path + ".steps.json")) if os.path.exists(script_path + ".steps.json") else []
        env["KISO_FAUX_SCRIPT"] = script_path
    else:
        env["OPENAI_BASE_URL"] = a.base_url
        env["OPENAI_API_KEY"] = os.environ[a.api_key_env]
        env["OPENAI_MODEL"] = a.model
    node = node_bin()
    prompt = os.path.join(task_dir, "PROMPT.txt")
    ctx = {"policy": policy, "steps": steps, "ref": ref, "overlay": a.overlay, "overlay_after": a.overlay_after,
           "injected": False, "approvals": [], "asks": 0, "deadline": a.deadline, "entry": a.entry,
           "prompt_text": open(prompt).read(), "home": home, "sid": sid}

    t0 = time.time()
    log.add("leg-start", task=a.task, arm=a.arm, overlay=a.overlay, sid=sid)
    argv1 = [node, a.cli, "chat", sid] + (["--task-file", prompt] if a.entry == "task-file" else [])
    leg, why = run_leg(argv1, env, ws, log, "pre", ctx)
    pty1 = leg.full
    arc = {"leg1": why, "leg1ExitStatus": leg.status, "leg2": None, "leg2ExitStatus": None, "injected": False,
           "overlay": a.overlay, "triggerWorld": ctx.get("trigger_world"), "terminalOutcome": None}
    injection = None
    if why == "trigger":
        if a.overlay == "kill":
            leg.crash()
            injection = {"kind": "kill", "signal": "SIGKILL", "durableLog": os.path.join(home, "sessions", sid + ".jsonl")}
        elif a.overlay == "term":
            # I-TERM: loss of the controlling terminal — the pty master is
            # closed with the process ALIVE (no signal from the harness). By
            # construction this is distinct from I-KILL; what the durable
            # record shows at that moment (a user abort? a crash signature?
            # neither?) is the measurement, recorded, never assumed.
            try:
                os.close(leg.fd)
            except OSError:
                pass
            deadline = time.time() + 15
            status = None
            while time.time() < deadline:
                try:
                    pid, st = os.waitpid(leg.pid, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid:
                    status = os.waitstatus_to_exitcode(st) if hasattr(os, "waitstatus_to_exitcode") else st
                    break
                time.sleep(0.2)
            leg.alive = False
            exited = status is not None
            if not exited:
                try:
                    os.kill(leg.pid, signal.SIGKILL)
                    os.waitpid(leg.pid, 0)
                except (ProcessLookupError, ChildProcessError):
                    pass
            injection = {"kind": "term", "signal": None, "channel": "pty master closed",
                         "exitedWithin15s": exited, "exitStatus": status,
                         "durableOutcomeAtInjection": durable_terminal(home, sid)}
        elif a.overlay == "restart":
            try:
                os.kill(leg.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.time() + 15
            while time.time() < deadline and leg.alive:
                leg.pump(0.2)
            if leg.alive:
                leg.crash()
                injection = {"kind": "restart", "signal": "SIGTERM", "note": "did not exit within 15s; SIGKILLed", "exitStatus": None}
            else:
                injection = {"kind": "restart", "signal": "SIGTERM", "exitStatus": leg.status}
            pty1 = leg.full
        log.add("injection", **{("overlay" if k == "kind" else k): v for k, v in injection.items()})
        ctx["injected"] = True
        arc["injected"] = True
        leg, why2 = run_leg([node, a.cli, "resume", sid], env, ws, log, "post", ctx)
        arc["leg2"] = why2
        arc["leg2ExitStatus"] = leg.status
        pty2 = leg.full
    else:
        leg.end()
        pty2 = b""
    arc["terminalOutcome"] = ctx.get("terminalOutcome")
    t1 = time.time()
    log.add("leg-end", arc=arc, wallSeconds=round(t1 - t0, 1))

    # ── the record ──
    leg_dir = os.path.join(a.runs, leg_id)
    os.makedirs(leg_dir)
    shutil.copytree(ws, os.path.join(leg_dir, "workspace"), symlinks=True)
    shutil.copy(log.path, os.path.join(leg_dir, "surrogate.jsonl"))
    shutil.copytree(home, os.path.join(leg_dir, "agent-state"), symlinks=True)  # durable log + traces: evidence for the cost extractor, never for the evaluator
    shutil.copy(a.policy, os.path.join(leg_dir, "policy.json"))
    if script_path:
        shutil.copy(script_path, os.path.join(leg_dir, "faux-script.json"))
        if os.path.exists(script_path + ".steps.json"):
            shutil.copy(script_path + ".steps.json", os.path.join(leg_dir, "faux-script.json.steps.json"))
    open(os.path.join(leg_dir, "pty-leg1.log"), "wb").write(pty1)
    if pty2:
        open(os.path.join(leg_dir, "pty-leg2.log"), "wb").write(pty2)

    if probe_ops is not None:
        time.sleep(1.0)  # let any launched command reach the endpoint before it is read
        rows = observe_calls(home, sid, policy, probe_ops, endpoint, ws)
        endpoint.stop()
        group = {"group": a.probe_group, "leg": leg_id, "endpoint": endpoint.url, "endpointHits": endpoint.hits, "rows": rows,
                 "approvals": ctx["approvals"], "terminalOutcome": arc.get("terminalOutcome")}
        json.dump(group, open(os.path.join(leg_dir, "policy-probe-group.json"), "w"), indent=1)
        shutil.rmtree(root, ignore_errors=True)
        print(f"[lh1:probe-group-json] {json.dumps(group)}")
        return 0

    # ── the external evaluation: the workspace path and nothing else ──
    code, out = run_node(os.path.join(task_dir, "evaluator.mjs"), os.path.join(leg_dir, "workspace"))
    open(os.path.join(leg_dir, "evaluate.log"), "w").write(out)
    verdict = None
    for line in out.split("\n"):
        if line.startswith("[lh1:verdict-json] "):
            verdict = json.loads(line[len("[lh1:verdict-json] "):])
    json.dump(verdict, open(os.path.join(leg_dir, "verdict.json"), "w"), indent=1)

    version = None
    try:
        version = json.load(open(os.path.join(os.path.dirname(a.cli), "..", "package.json")))["version"]
    except (OSError, ValueError, KeyError):
        pass
    try:
        bench_commit = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    except OSError:
        bench_commit = None
    meta = {
        "leg": leg_id, "task": a.task, "arm": a.arm, "entry": a.entry, "overlay": a.overlay, "overlayAfter": a.overlay_after if a.overlay != "none" else None,
        "label": a.label, "sessionId": sid,
        "provenance": {
            "agent": "kiso", "agentVersion": version, "cli": a.cli, "cliSource": "tree" if a.cli.startswith(REPO) else "released",
            "model": None if a.arm == "faux" else a.model, "baseUrl": None if a.arm == "faux" else a.base_url,
            "benchBaselineCommit": bench_commit, "driver_sha256": rd1.sha16(os.path.abspath(__file__)), "rd1_driver_sha256": rd1.sha16(RD1_DRIVER),
            "policy_sha256": rd1.sha16(a.policy), "fauxScript_sha256": rd1.sha16(script_path) if script_path else None,
            "envKeys": sorted(env.keys()), "isolateHome": True, "mode": env["KISO_MODE"], "workRoot": root,
            "systemPromptHash": first_request_field(home, sid, "systemPromptHash"), "toolSchemaHash": first_request_field(home, sid, "toolSchemaHash"),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        },
        "arc": arc, "injection": injection,
        "surrogate": {"approvals": ctx["approvals"], "asksUnanswered": ctx["asks"], "answerLatencyMs": policy["surrogate"]["answerLatencyMs"],
                      "humanWaitMs": sum(x["waitMs"] for x in ctx["approvals"])},
        "worldSteps": {"total": len(steps), "doneAtEnd": world_steps_done(os.path.join(leg_dir, "workspace"), steps, ref)},
        "wallSeconds": round(t1 - t0, 1),
        "evaluate": {"exit": code, "pass": bool(verdict and verdict.get("pass")), "checks": None if not verdict else f"{sum(1 for c in verdict['checks'] if c['ok'])}/{len(verdict['checks'])}"},
    }
    json.dump(meta, open(os.path.join(leg_dir, "meta.json"), "w"), indent=1)
    shutil.rmtree(root, ignore_errors=True)

    archived = ""
    if a.archive:
        code2, out2 = run_node(os.path.join(LH1, "run", "archive.mjs"), "--create", leg_dir, a.archive, leg_id)
        archived = f" archive={'INTACT' if code2 == 0 else 'FAILED'}"
    print(f"[lh1:leg] {leg_id} arm={a.arm} overlay={a.overlay} leg1={arc['leg1']} leg2={arc['leg2']} terminal={arc['terminalOutcome']} "
          f"steps={meta['worldSteps']['doneAtEnd']}/{len(steps)} approvals={len(ctx['approvals'])} asks={ctx['asks']} "
          f"wait={meta['surrogate']['humanWaitMs']}ms wall={meta['wallSeconds']}s evaluate={'PASS' if meta['evaluate']['pass'] else 'FAIL'} {meta['evaluate']['checks']}{archived}")
    return 0 if meta["evaluate"]["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
