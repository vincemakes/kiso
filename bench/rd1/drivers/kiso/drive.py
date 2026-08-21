#!/usr/bin/env python3
"""RD-1 kiso driver — python stdlib only, reproducible in-repo.

Drives the kiso CLI through one scenario on a 0-row pty (the dock-less
fallback path: plain-text questions, no panels). The human surrogate
policy is frozen in ../../SCENARIOS.md: approvals are granted when
asked, uncertainty verdicts are answered from workspace artifacts
only (deploy-output.txt), nothing is volunteered, every interaction
is logged for the silent-retry axis.

usage: drive.py --scenario ../../scenarios/c4.json --cli <index.js>
               --out <dir> [--model ...] [--base-url ...]
"""
import argparse
import fcntl
import hashlib
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RD1 = os.path.abspath(os.path.join(HERE, "..", ".."))
EFFECT = os.path.join(RD1, "harness", "effect.py")
PROXY = os.path.join(RD1, "harness", "proxy.py")
SCORE = os.path.join(RD1, "harness", "score.py")
LEG_DEADLINE = 420
QUIET_DONE = 8.0


def sha16(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]


class Log:
    def __init__(self, path):
        self.path = path

    def add(self, kind, **kw):
        row = {"kind": kind, "ts": time.time(), **kw}
        with open(self.path, "a") as f:
            f.write(json.dumps(row) + "\n")


class Leg:
    """One pty life of the agent (fresh run or resume)."""

    def __init__(self, argv, env, cwd):
        pid, fd = pty.fork()
        if pid == 0:
            # 0-row tty: forces kiso's dock-less fallback path (plain-text
            # questions, no panels) — the reproducible surface, the kill9
            # test's own precedent (rows < 4).
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 0, 120, 0, 0))
            except OSError:
                pass
            os.chdir(cwd)
            os.environ.clear()
            os.environ.update(env)
            try:
                os.execvp(argv[0], argv)
            except Exception as e:
                os.write(2, str(e).encode())
                os._exit(127)
        self.pid, self.fd = pid, fd
        self.buf = b""
        self.full = b""
        self.alive = True
        self.last_data = time.time()

    def _reap(self):
        # Liveness is the child's exit, not a quiet read: an idle agent
        # produces no bytes for many seconds without being dead.
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            self.alive = False
            return
        if pid:
            self.alive = False

    def pump(self, timeout=0.1):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if r:
            try:
                data = os.read(self.fd, 4096)
            except OSError:
                self._reap()
                return
            if not data:
                self._reap()
                return
            self.buf += data
            self.full += data
            self.last_data = time.time()
        else:
            self._reap()

    def consume(self, needle):
        idx = self.buf.find(needle)
        if idx < 0:
            return False
        self.buf = self.buf[idx + len(needle):]
        return True

    def send(self, s):
        os.write(self.fd, s.encode() if isinstance(s, str) else s)

    def crash(self):
        """Crash injection, NOT abort injection (RD-1 injection-integrity
        principle): the failure must arrive as a real process death, never
        through the agent's control channel. kiso treats a closed pty
        master as EOF -> graceful exit (R-G 0.1.48, correct product
        behavior), so closing our master would forge an 'aborted by user'
        terminal instead of a crash. Therefore: SIGKILL the main process
        FIRST (uncatchable, no handler runs, no EOF is read), reap it,
        and only THEN close our fd — the process is already gone, so the
        close can no longer be read as a hangup. The group SIGKILL that
        follows sweeps any detached tool children."""
        try:
            os.kill(self.pid, signal.SIGKILL)   # the CLI itself, first and hardest
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)             # reap BEFORE touching the fd
        except ChildProcessError:
            pass
        try:
            os.killpg(self.pid, signal.SIGKILL)  # sweep the (now-dead leader's) group
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.close(self.fd)                    # safe now: nothing alive to read EOF
        except OSError:
            pass
        self.alive = False

    def end(self):
        # Called only AFTER run_leg returned done/died. If the agent is
        # already gone, reap and go. If still alive (a clean 'done' with
        # the process idling for input), \x04 is a legitimate end-of-turn
        # here — the run already completed, so there is no pending
        # approval for it to forge into an abort (unlike the crash path).
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return
        except ChildProcessError:
            return
        try:
            self.send("\x04")
        except OSError:
            pass
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                return
            if pid:
                return
            self.pump(0.2)
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


def seed(scn, out):
    out = os.path.abspath(out)
    work = os.path.join(out, "work")
    os.makedirs(work)
    for rel, content in scn["files"].items():
        p = os.path.join(work, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(content)
    # absolute: deploy.sh runs with cwd=work, the ledger lives OUTSIDE it.
    ledger = os.path.join(out, "ledger.jsonl")
    detach = " --detach" if scn.get("effectMode") == "detach" else ""
    deploy = os.path.join(work, "deploy.sh")
    open(deploy, "w").write(
        "#!/bin/sh\n"
        f"exec python3 '{EFFECT}' --ledger '{ledger}' --effect {scn['effectId']} "
        f"--sleep {scn.get('effectSleep', 5)} --output deploy-output.txt{detach}\n"
    )
    os.chmod(deploy, 0o755)
    git = lambda *a: subprocess.run(["git", *a], cwd=work, check=True, capture_output=True)
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.email=rd1@bench", "-c", "user.name=rd1", "commit", "-q", "-m", "seed")
    git("tag", "seed")
    return work, ledger


def ledger_phase_rows(ledger, phase):
    try:
        return [json.loads(x) for x in open(ledger) if x.strip() and json.loads(x)["phase"] == phase]
    except OSError:
        return []


def file_has(work, rel, needle):
    try:
        return needle in open(os.path.join(work, rel)).read()
    except OSError:
        return False


def trigger_fired(scn, work, ledger, leg, state):
    t = scn.get("trigger")
    if t is None:
        return False
    kind = t["type"]
    if kind == "file-needle":
        return file_has(work, t["path"], t["needle"])
    if kind == "ledger-start":
        return len(ledger_phase_rows(ledger, "start")) >= 1
    if kind == "ledger-end-delay":
        rows = ledger_phase_rows(ledger, "end")
        if rows and state.get("end_seen_at") is None:
            state["end_seen_at"] = time.time()
        return state.get("end_seen_at") is not None and time.time() - state["end_seen_at"] >= t.get("delay", 1.0)
    if kind == "status-exists":
        return os.path.exists(os.path.join(work, "STATUS.md"))
    if kind == "second-file-change":
        changed = {rel for rel, needle in t["watch"] if file_has(work, rel, needle)}
        return len(changed) >= 2
    return False


def run_leg(argv, env, work, ledger, scn, log, phase, state):
    """One agent life, driven by WORLD ARTIFACTS (crux c option A, owner ruling
    2026-08-21): progress and completion are judged from the filesystem
    (ledger rows, deploy-output.txt, STATUS.md), never from screen
    rendering — a 0-row tty renders the agent's own questions but not its
    output. The screen is read ONLY to answer the fallback questions
    (approval y/n, the uncertainty 'did it apply?'), which DO render
    there. The surrogate answers those from workspace truth alone."""
    leg = Leg(argv, env, work)
    # readiness differs by phase. A FRESH run prints the banner
    # ('extensions:'); waiting for it means the input line is live, then
    # we send the task. A RESUME prints NO banner — it replays the
    # durable log and continues the interrupted run via session.resume()
    # on its own (resume.ts: "continued via session.resume(), never
    # faked with a new prompt"). So a resume leg needs NO readiness gate
    # and NO nudge: we go straight into the answer loop, because the very
    # first thing it may do is re-raise the interrupted approval, which
    # the loop must answer.
    if phase == "pre":
        ready_deadline = time.time() + 40
        while time.time() < ready_deadline:
            leg.pump(0.2)
            if not leg.alive:
                return leg, "died"
            if b"extensions:" in leg.full:
                break
        time.sleep(1.0)
        for _ in range(3):
            leg.pump(0.1)
        leg.send(scn["prompt"] + "\r")
        log.add("prompt-sent")
    else:
        log.add("resume-start")

    status_path = os.path.join(work, "STATUS.md")
    status_seen_at = None
    start = time.time()
    while time.time() - start < LEG_DEADLINE:
        leg.pump(0.2)
        if not leg.alive:
            return leg, "died"

        # ── screen is consulted ONLY for the fallback questions ──
        if leg.consume(b"did it apply?"):
            ans = "y" if os.path.exists(os.path.join(work, "deploy-output.txt")) else "n"
            log.add("uncertainty-verdict", answer="yes" if ans == "y" else "no")
            leg.send(ans + "\r")
            continue
        if scn.get("approvalScenario") and phase == "pre" and b"approve " in leg.buf:
            # C5: the approval is ON the surface — kill without answering.
            state["approval_seen_pre"] = True
            log.add("trigger", note="approval on surface, unanswered")
            return leg, "trigger"
        if leg.consume(b"approve "):
            leg.send("y\r")
            log.add("approve")
            if phase == "post":
                state["approve_post"] = True
            continue

        # ── everything else is a WORLD observation ──
        if phase == "pre" and trigger_fired(scn, work, ledger, leg, state):
            if state.get("snapshot") is None:
                state["snapshot"] = [n for n in scn.get("candidateSnapshotNeedles", []) if file_has(work, n["path"], n["needle"])]
            log.add("trigger", note=scn["trigger"]["type"])
            return leg, "trigger"

        if scn.get("injection") == "external-append" and not state.get("appended") and os.path.exists(os.path.join(work, scn["appendWhen"])):
            with open(os.path.join(work, scn["appendTo"]), "a") as f:
                f.write(scn["appendLine"])
            state["appended"] = True
            log.add("external-append", path=scn["appendTo"])

        if scn.get("injection") == "heartbeat":
            n = state.get("beats", 0)
            if n < scn["beatCount"] and time.time() - state.get("beat_at", start) >= scn["beatEvery"]:
                with open(os.path.join(work, scn["beatTo"]), "a") as f:
                    f.write(scn["beatLine"].format(n=n + 1))
                state["beats"] = n + 1
                state["beat_at"] = time.time()
                log.add("external-append", path=scn["beatTo"], beat=n + 1)

        # completion is a WORLD fact: STATUS.md exists and has stayed
        # stable for the settle window (the agent wrote it and stopped).
        if os.path.exists(status_path):
            if status_seen_at is None:
                status_seen_at = time.time()
            elif time.time() - status_seen_at >= QUIET_DONE:
                return leg, "done"
        else:
            status_seen_at = None
    return leg, "deadline"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--base-url", default="https://api.deepseek.com")
    ap.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    a = ap.parse_args()

    scn = json.load(open(a.scenario))
    # everything absolute: the CLI runs with cwd=work, so a relative
    # KISO_HOME/cli/scenario would resolve under the workspace (the
    # 'died' bug — KISO_HOME landed inside work/ and the store failed).
    a.out = os.path.abspath(a.out)
    a.cli = os.path.abspath(a.cli)
    a.scenario = os.path.abspath(a.scenario)
    os.makedirs(a.out)
    work, ledger = seed(scn, a.out)
    home = os.path.join(a.out, "home")
    os.makedirs(home)
    log = Log(os.path.join(a.out, "surrogate.jsonl"))
    sid = f"rd1-{scn['id']}-{int(time.time())}"

    base_url = a.base_url
    proxy_proc = None
    proxy_state = None
    if scn.get("injection") == "proxy":
        port = 18000 + os.getpid() % 1000
        proxy_state = os.path.join(a.out, "proxy-state.json")
        upstream = a.base_url.split("://", 1)[1]
        proxy_proc = subprocess.Popen(
            [sys.executable, PROXY, "--port", str(port), "--upstream", upstream,
             "--scheme", a.base_url.split("://")[0], "--state", proxy_state,
             "--cut-bytes", str(scn.get("cutBytes", 2048))],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base_url = f"http://127.0.0.1:{port}"
        time.sleep(1)

    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ["HOME"],
        "TERM": "dumb",
        "KISO_HOME": home,
        "KISO_MODE": "accept-edits",
        "OPENAI_BASE_URL": base_url,
        "OPENAI_API_KEY": os.environ[a.api_key_env],
        "OPENAI_MODEL": a.model,
    }
    node = subprocess.run(["which", "node"], capture_output=True, text=True).stdout.strip()
    state = {}
    injected = False

    durable_log = os.path.join(home, "sessions", sid + ".jsonl")

    def durable_max_seq():
        try:
            seqs = [json.loads(x)["event"].get("seq", 0) for x in open(durable_log) if x.strip()]
            return max(seqs) if seqs else 0
        except OSError:
            return 0

    leg, why = run_leg([node, a.cli, sid], env, work, ledger, scn, log, "pre", state)
    kill_seq = None
    if why == "trigger":
        # snapshot was taken inside run_leg at the exact trigger instant.
        kill_seq = durable_max_seq()  # the last committed seq the crash interrupts
        leg.crash()
        log.add("injection", injection="kill", killSeq=kill_seq)
        injected = True
        time.sleep(1.5)
        leg, why2 = run_leg([node, a.cli, "resume", sid], env, work, ledger, scn, log, "post", state)
        leg.end()
    else:
        leg.end()
        why2 = why
    if proxy_proc:
        proxy_proc.terminate()

    # approval fields (c5)
    approval_surface = None
    approval_recovery = None
    if scn.get("approvalScenario"):
        approval_surface = "AVAILABLE" if state.get("approval_seen_pre") else "UNKNOWN"
        if state.get("approval_seen_pre"):
            if state.get("approve_post"):
                approval_recovery = "PASS"
            elif len(ledger_phase_rows(ledger, "start")) >= 1:
                approval_recovery = "FAIL"  # effect ran post-crash with no re-ask
            else:
                approval_recovery = "FAIL"  # the pending approval vanished

    manifest = {
        "scenario": scn["id"],
        "ledger": ledger,
        "effectId": scn["effectId"],
        "statusPath": os.path.join(work, "STATUS.md"),
        "surrogateLog": log.path,
        "snapshotNeedles": [{"path": os.path.join(work, n["path"]), "needle": n["needle"]} for n in state.get("snapshot", [])],
        "requiredNeedles": [{"path": os.path.join(work, n["path"]), "needle": n["needle"]} for n in scn.get("requiredNeedles", [])],
        "expectedEndCount": scn.get("expectedEndCount", 1),
    }
    if injected:
        manifest["injection"] = {"kind": "kill", "durableLogPath": durable_log, "killSeqAtInjection": kill_seq}
    if approval_surface is not None:
        manifest["approvalSurface"] = approval_surface
        manifest["approvalRecovery"] = approval_recovery
    mp = os.path.join(a.out, "score-manifest.json")
    json.dump(manifest, open(mp, "w"), indent=1)
    verdict = json.loads(subprocess.run([sys.executable, SCORE, mp], capture_output=True, text=True).stdout)

    cli_pkg = os.path.join(os.path.dirname(a.cli), "..", "package.json")
    version = None
    try:
        version = json.load(open(cli_pkg))["version"]
    except OSError:
        pass
    report = {
        "provenance": {
            "scenario": scn["id"], "sessionId": sid, "agent": "kiso",
            "agentVersion": version, "cli": a.cli, "model": a.model,
            "baseUrlMode": "proxy" if scn.get("injection") == "proxy" else "direct",
            "driver_sha256": sha16(os.path.abspath(__file__)),
            "harness_sha256": {os.path.basename(p): sha16(p) for p in (EFFECT, SCORE, PROXY)},
            "scenario_sha256": sha16(a.scenario),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        },
        "arc": {"leg1": why, "leg2": why2 if injected else None, "injected": injected},
        "verdict": verdict,
    }
    json.dump(report, open(os.path.join(a.out, "run.json"), "w"), indent=1)
    axes = verdict["axes"]
    line = " ".join(f"{k}={v}" for k, v in axes.items())
    integ = verdict.get("injection_integrity", "N/A")
    print(f"[rd1:{scn['id']}] INJECTION={integ} | {line}" + (f" | surface={verdict.get('approval_surface')} recovery={verdict.get('approval_recovery')}" if "approval_surface" in verdict else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
