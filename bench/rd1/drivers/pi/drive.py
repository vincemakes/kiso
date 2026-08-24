#!/usr/bin/env python3
"""RD-1 pi driver — python stdlib only, reproducible in-repo.

Drives the pi CLI (earendil-works/pi) through one scenario using its
native session model: `pi -p --session-id <id>` runs a headless turn and
exits; the SAME --session-id resumes/continues. pi is yolo by design
(no permission gate), so the approval scenarios (C5) score approval N/A
for pi — a HONEST cross-agent difference, not a harness gap. Model held
constant with the kiso arm: deepseek-v4-flash via `--provider deepseek`.

The world-injection harness (effect.py deploy, proxy, external-append,
heartbeat) and the agent-neutral scorer are SHARED verbatim with the
kiso driver; only the per-agent interaction layer differs. Every
manifest carries the REQUIRED scenarioIntent block (the scorer
hard-asserts it) copied from the frozen scenario file — the same
contract the audit fixed.

usage: drive.py --scenario ../../scenarios/c4.json --out <dir>
               [--model deepseek-v4-flash] [--provider deepseek]
"""
import argparse
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

# reuse the kiso driver's agent-neutral world helpers verbatim
sys.path.insert(0, os.path.join(HERE, "..", "kiso"))
import drive as kiso_drive  # noqa: E402  seed/effect_pgids/ledger_counts/Log


def pi_provenance(a, scn):
    """RD1B-F2 — the competitor arm carries the SAME provenance as the
    self arm.

    RD-1B shipped with pi's run.json holding only {tool, scenario,
    piVersion, model, verdict}: no harness sha, no driver sha, no
    scenario sha, no timestamp. That is a fairness hole in a competitive
    benchmark — nothing in the artifacts proved both arms were scored by
    the same scorer, so the grid rested on the operator's memory. It
    rests on the files now.
    """
    try:
        bench_commit = subprocess.run(["git", "-C", RD1, "rev-parse", "HEAD"],
                                      capture_output=True, text=True).stdout.strip()
    except Exception:
        bench_commit = None
    try:
        version = subprocess.run(["pi", "--version"], capture_output=True, text=True).stdout.strip()
    except Exception:
        version = None
    return {
        "scenario": scn["id"], "agent": "pi", "agentVersion": version,
        "model": a.model,
        "baseUrlMode": "proxy" if scn.get("injection") == "proxy" else "direct",
        "benchBaselineCommit": bench_commit,
        "driver_sha256": kiso_drive.sha16(os.path.abspath(__file__)),
        "harness_sha256": {os.path.basename(p): kiso_drive.sha16(p) for p in (EFFECT, SCORE, PROXY)},
        "axis0_version": kiso_drive.sha16(SCORE),
        "scenario_sha256": kiso_drive.sha16(a.scenario),
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def write_pi_run(a, scn, verdict):
    """The ONE run.json writer. Every exit path goes through it so a new
    one cannot silently ship without provenance — which is how the
    original three call sites all omitted it."""
    prov = pi_provenance(a, scn)
    json.dump({"tool": "pi", "scenario": scn["id"],
               "piVersion": prov["agentVersion"], "model": a.model,
               "provenance": prov, "verdict": verdict},
              open(os.path.join(a.out, "run.json"), "w"), indent=1)


LEG_DEADLINE = 420
QUIET_DONE = 6.0


class Leg:
    """One pty life of pi (fresh -p turn or a --session-id resume)."""

    def __init__(self, argv, env, cwd):
        pid, fd = pty.fork()
        if pid == 0:
            try:
                a = struct.pack("HHHH", 0, 0, 0, 0)
                import fcntl
                fcntl.ioctl(1, termios.TIOCSWINSZ, a)
            except Exception:
                pass
            os.chdir(cwd)
            os.environ.update(env)
            os.execvp(argv[0], argv)
        self.pid = pid
        self.fd = fd
        self.buf = b""
        self.raw = b""
        self.alive = True

    def pump(self, timeout):
        try:
            r, _, _ = select.select([self.fd], [], [], timeout)
        except (OSError, ValueError):
            return False
        if not r:
            return False
        try:
            chunk = os.read(self.fd, 65536)
        except OSError:
            self.alive = False
            return False
        if not chunk:
            self.alive = False
            return False
        self.buf += chunk
        self.raw += chunk
        return True

    def crash(self, effect_pgids=None):
        """A real process death, never a control-channel abort (the
        injection-integrity law). SIGKILL the CLI first (uncatchable),
        reap it, then close the fd; sweep the group and any effect group."""
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        try:
            os.killpg(self.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        for pgid in (effect_pgids or []):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        self.alive = False

    def end(self):
        deadline = time.time() + 8
        while self.alive and time.time() < deadline:
            if not self.pump(0.2):
                break
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.alive = False


def pi_session_path(sess_dir):
    """The newest session jsonl under the dedicated --session-dir — used
    only for Axis-0's durable-tail read. pi may nest by cwd-slug or write
    flat, so walk the tree."""
    newest = None
    for root, _, files in os.walk(sess_dir):
        for f in files:
            if f.endswith(".jsonl"):
                p = os.path.join(root, f)
                if newest is None or os.path.getmtime(p) > os.path.getmtime(newest):
                    newest = p
    return newest


def run_leg(argv, env, work, ledger, scn, log, phase, state):
    leg = Leg(argv, env, work)
    deadline = time.time() + LEG_DEADLINE
    last = time.time()
    injected_here = False
    while leg.alive and time.time() < deadline:
        if leg.pump(0.2):
            last = time.time()
        # a WORLD trigger for the kill scenarios (fires on the exact ledger
        # shape, the same agent-neutral condition the kiso driver uses)
        if phase == "pre" and scn.get("trigger") and kiso_drive.trigger_fired(scn, work, ledger, leg, state):
            if state.get("snapshot") is None:
                state["snapshot"] = [n for n in scn.get("candidateSnapshotNeedles", []) if kiso_drive.file_has(work, n["path"], n["needle"])]
            log.add("trigger", note=scn["trigger"]["type"])
            return leg, "trigger"
        # external-append / heartbeat world injections (agent-neutral)
        if scn.get("injection") == "external-append" and not state.get("appended") and os.path.exists(os.path.join(work, scn["appendWhen"])):
            with open(os.path.join(work, scn["appendTo"]), "a") as f:
                f.write(scn["appendLine"])
            state["appended"] = True
            log.add("external-append", path=scn["appendTo"])
        if scn.get("injection") == "heartbeat":
            n = state.get("beats", 0)
            if n < scn["beatCount"] and time.time() - state.get("beat_at", state.setdefault("leg_start", time.time())) >= scn["beatEvery"]:
                with open(os.path.join(work, scn["beatTo"]), "a") as f:
                    f.write(scn["beatLine"].format(n=n + 1))
                state["beats"] = n + 1
                state["beat_at"] = time.time()
                log.add("external-append", path=scn["beatTo"], beat=n + 1)
        # quiet-done: pi's -p exits on its own at agent_end; the pump loop
        # ends when the child dies. A stall past QUIET_DONE with no output
        # is also done (the model finished, the pty just idles).
        if time.time() - last > QUIET_DONE and not leg.alive:
            break
    return leg, "done"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--provider", default="deepseek")
    ap.add_argument("--base-url", default="https://api.deepseek.com")
    ap.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    a = ap.parse_args()

    scn = json.load(open(a.scenario))
    a.out = os.path.abspath(a.out)
    a.scenario = os.path.abspath(a.scenario)
    os.makedirs(a.out)
    work, ledger = kiso_drive.seed(scn, a.out)
    pi_sess = os.path.join(a.out, "pi-sessions")
    os.makedirs(pi_sess)
    log = kiso_drive.Log(os.path.join(a.out, "surrogate.jsonl"))
    sid = f"rd1-{scn['id']}-{int(time.time())}"

    base_url = a.base_url
    proxy_proc = None
    proxy_state = None
    if scn.get("injection") == "proxy":
        port = 18500 + os.getpid() % 400
        proxy_state = os.path.join(a.out, "proxy-state.json")
        upstream = a.base_url.split("://", 1)[1]
        proxy_proc = subprocess.Popen(
            [sys.executable, PROXY, "--port", str(port), "--upstream", upstream,
             "--scheme", a.base_url.split("://")[0], "--state", proxy_state,
             "--cut-bytes", str(scn.get("cutBytes", 2048))],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base_url = f"http://127.0.0.1:{port}"
        time.sleep(1.5)

    # pi reads DeepSeek creds from DEEPSEEK_API_KEY (the bench precedent,
    # run-one.sh); the proxy retarget rides the OpenAI-compat base url pi
    # honors for the deepseek provider.
    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ["HOME"],
        "TERM": "dumb",
        "PI_CODING_AGENT_SESSION_DIR": pi_sess,
        "DEEPSEEK_API_KEY": os.environ[a.api_key_env],
        "OPENAI_BASE_URL": base_url,
        "DEEPSEEK_BASE_URL": base_url,
    }
    prompt = scn["prompt"]
    argv = ["pi", "--provider", a.provider, "--model", a.model, "-p", "--mode", "json",
            "--session-dir", pi_sess, "--session-id", sid, prompt]

    state = {}
    leg, why = run_leg(argv, env, work, ledger, scn, log, "pre", state)

    kill_seq = None
    kill_world = None
    post_kill_world = None
    injected = False
    # C5 (approval-surface scenario): the injection fires WHEN the agent
    # surfaces an approval and waits. pi is yolo — it has NO approval
    # surface, so the approve-needle trigger can never fire and the kill
    # never lands. That is a REAL, HONEST cross-agent difference, not a
    # harness failure: the scenario is CONCEPTUALLY N/A for a
    # permissionless agent. Record it as such and skip the injection
    # scoring (which would else brand pi's absent surface as a crash-gate
    # FAIL).
    if scn.get("injection") == "proxy":
        leg.end()
        if proxy_proc:
            proxy_proc.terminate()
        fired = False
        try:
            fired = json.load(open(proxy_state)).get("fired", False) if proxy_state else False
        except Exception:
            pass
        verdict = {
            "scenario": scn["id"],
            "injection_integrity": "N/A",
            "injection_observation": ("proxy fired but " if fired else "") +
                "pi's built-in deepseek endpoint is NOT retargetable via env (DEEPSEEK_BASE_URL is ignored; pi connects to the real api.deepseek.com), so the stream-cut proxy cannot intercept pi's traffic — the scenario is untestable for pi with this mechanism (excluded-with-reason, never a false PASS)",
            "axes": {k: "N/A" for k in ("duplicate_effect", "silent_retry", "lost_work", "fabricated_certainty", "deterministic_recovery")},
            "observations": {"endpoint_retargetable": False, "proxy_fired": fired},
        }
        write_pi_run(a, scn, verdict)
        print(f"[rd1:{scn['id']}] pi INJECTION=N/A | endpoint not retargetable — stream-cut untestable for pi (excluded)")
        return 0
    if scn.get("approvalScenario") and why != "trigger":
        leg.end()
        if proxy_proc:
            proxy_proc.terminate()
        verdict = {
            "scenario": scn["id"],
            "injection_integrity": "N/A",
            "injection_observation": "approval-surface scenario, but pi has no approval surface (yolo) — the approve-needle trigger cannot fire; the scenario is N/A for a permissionless agent",
            "axes": {k: "N/A" for k in ("duplicate_effect", "silent_retry", "lost_work", "fabricated_certainty", "deterministic_recovery")},
            "observations": {"approval_surface": "ABSENT (pi is yolo)"},
        }
        write_pi_run(a, scn, verdict)
        print(f"[rd1:{scn['id']}] pi INJECTION=N/A | approval-surface ABSENT (yolo) — scenario N/A for pi")
        return 0
    if why == "trigger":
        kill_world = kiso_drive.ledger_counts(ledger)
        pgids = kiso_drive.effect_pgids(ledger) if scn.get("injection") == "kill-effect-group" else []
        leg.crash(pgids)
        ends_at_kill = kill_world["ends"]
        settle = time.time() + scn.get("effectSleep", 6) + 3
        while time.time() < settle:
            if kiso_drive.ledger_counts(ledger)["ends"] > ends_at_kill:
                break
            time.sleep(0.3)
        post_kill_world = {"effect_survived": kiso_drive.ledger_counts(ledger)["ends"] > ends_at_kill,
                           "startsAtKill": kill_world["starts"], "endsAtKill": ends_at_kill}
        log.add("injection", injection="kill", killWorld=kill_world, postKillWorld=post_kill_world)
        injected = True
        # resume: the SAME session id continues pi's durable session
        resume_argv = ["pi", "--provider", a.provider, "--model", a.model, "-p", "--mode", "json",
                       "--session-dir", pi_sess, "--session-id", sid, "Continue where you left off and finish the task."]
        leg, why2 = run_leg(resume_argv, env, work, ledger, scn, log, "post", state)
        leg.end()
    else:
        leg.end()

    if proxy_proc:
        proxy_proc.terminate()

    durable_log = pi_session_path(pi_sess)

    manifest = {
        "scenario": scn["id"],
        "ledger": ledger,
        "effectId": scn["effectId"],
        "statusPath": os.path.join(work, "STATUS.md"),
        "surrogateLog": log.path,
        "snapshotNeedles": [{"path": os.path.join(work, n["path"]), "needle": n["needle"]} for n in state.get("snapshot", [])],
        "requiredNeedles": [{"path": os.path.join(work, n["path"]), "needle": n["needle"]} for n in scn.get("requiredNeedles", [])],
        "expectedEndCount": scn.get("expectedEndCount", 1),
        "scenarioIntent": {
            "injectionType": scn.get("injection"),
            "effectMode": scn.get("effectMode", "plain"),
            "intendedPostKillWorld": scn.get("postKillWorld"),
            "intendedKillWorld": scn.get("killWorld"),
        },
    }
    if injected:
        # pi's durable tail is its own session jsonl; Axis-0 reads it to
        # confirm the kill was a crash, not a forged abort. pi has no
        # 'aborted by user' / 'denied by user' vocabulary, so a genuine
        # SIGKILL simply leaves the session truncated mid-turn — the
        # absence of a clean turn_end after the kill is the crash tail.
        manifest["injection"] = {
            "kind": "kill",
            "durableLogPath": durable_log or "/nonexistent",
            "durableLogFormat": "pi",
            "killSeqAtInjection": 0,
            "killWorld": kill_world,
            "postKillWorld": post_kill_world,
        }

    mp = os.path.join(a.out, "score-manifest.json")
    json.dump(manifest, open(mp, "w"), indent=1)
    r = subprocess.run([sys.executable, SCORE, mp], capture_output=True, text=True)
    try:
        verdict = json.loads(r.stdout)
    except Exception:
        verdict = {"error": r.stderr[:200]}
    write_pi_run(a, scn, verdict)

    ax = verdict.get("axes", {})
    print(f"[rd1:{scn['id']}] pi INJECTION={verdict.get('injection_integrity','?')} | "
          + " ".join(f"{k}={v}" for k, v in ax.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
