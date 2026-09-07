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
import importlib.util
import json
import os
import shutil
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
            cls = policy["toolClass"].get(tool, "unclassified")
            cell = policy["matrix"].get(cls, "deny")
            answer = "y" if cell == "ask" else "n"
            time.sleep(policy["surrogate"]["answerLatencyMs"] / 1000.0)
            leg.send(answer + "\r")
            ctx["approvals"].append({"tool": tool, "class": cls, "cell": cell, "answer": answer, "phase": phase, "waitMs": round((time.time() - seen) * 1000)})
            log.add("approval", tool=tool, cls=cls, cell=cell, answer=answer, phase=phase, waitMs=ctx["approvals"][-1]["waitMs"])
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
    a = ap.parse_args()

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
    if a.arm == "faux":
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
