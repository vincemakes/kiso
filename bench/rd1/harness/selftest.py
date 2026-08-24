#!/usr/bin/env python3
"""RD-1 instrument selftest — the instruments' own red/green proof.

No model, no agent: pure world physics. An instrument that cannot
distinguish the worlds it exists to distinguish measures nothing
(the PE-1 selftest law). Checks:

  1. plain effect killed mid-window  -> start row, NO end, NO output
  2. detached effect killed at start -> worker survives: end + output
  3. duplicate identity rule         -> two attempts, one effectId ->
                                        duplicate FAIL + silent FAIL
     (and: an authorized rerun       -> duplicate PASS, silent PASS)
  4. scorer matrix                   -> fabricated yes / honest
                                        unknown / lost-work needle
  5. proxy                           -> cuts first stream at N bytes,
                                        passes the second untouched
"""
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import http.server
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
EFFECT = os.path.join(HERE, "effect.py")
SCORE = os.path.join(HERE, "score.py")
PROXY = os.path.join(HERE, "proxy.py")
FAILURES = []


def check(name, ok, detail=""):
    print(f"[rd1:selftest] {'ok ' if ok else 'RED'} — {name}{(' (' + detail + ')') if detail and not ok else ''}")
    if not ok:
        FAILURES.append(name)


def wait_for(pred, timeout, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return False


def ledger_rows(path, phase=None):
    try:
        rows = [json.loads(x) for x in open(path) if x.strip()]
    except OSError:
        return []
    return [r for r in rows if phase is None or r["phase"] == phase]


def spawn_group(argv):
    return subprocess.Popen(argv, preexec_fn=os.setsid, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def t1_plain_dies(tmp):
    ledger = os.path.join(tmp, "l1.jsonl")
    out = os.path.join(tmp, "o1.txt")
    p = spawn_group([sys.executable, EFFECT, "--ledger", ledger, "--effect", "e1", "--sleep", "4", "--output", out])
    got_start = wait_for(lambda: ledger_rows(ledger, "start"), 5)
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    time.sleep(5)  # were a worker secretly alive, it would finish in this window
    check("plain effect dies with its group: start row present", got_start)
    check("plain effect dies with its group: NO end row after the wait", not ledger_rows(ledger, "end"))
    check("plain effect dies with its group: NO output artifact", not os.path.exists(out))


def t2_detached_survives(tmp):
    ledger = os.path.join(tmp, "l2.jsonl")
    out = os.path.join(tmp, "o2.txt")
    p = spawn_group([sys.executable, EFFECT, "--ledger", ledger, "--effect", "e2", "--sleep", "3", "--output", out, "--detach"])
    got_start = wait_for(lambda: ledger_rows(ledger, "start"), 5)
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    check("detached: start row seen before the kill", got_start)
    finished = wait_for(lambda: ledger_rows(ledger, "end"), 8)
    check("detached: the orphaned worker finished after the group died", finished)
    check("detached: the output artifact exists", os.path.exists(out))


def run_score(manifest, tmp, name):
    mp = os.path.join(tmp, name)
    json.dump(manifest, open(mp, "w"))
    out = subprocess.run([sys.executable, SCORE, mp], capture_output=True, text=True)
    return json.loads(out.stdout)


def t3_duplicate_rule(tmp):
    ledger = os.path.join(tmp, "l3.jsonl")
    out = os.path.join(tmp, "o3.txt")
    for _ in range(2):
        subprocess.run([sys.executable, EFFECT, "--ledger", ledger, "--effect", "e3", "--sleep", "0.05", "--output", out], stdout=subprocess.DEVNULL)
    slog = os.path.join(tmp, "s3-empty.jsonl")
    open(slog, "w").close()
    status = os.path.join(tmp, "STATUS3.md")
    open(status, "w").write("deployed: yes\n")
    base = {"scenario": "self3", "ledger": ledger, "effectId": "e3", "statusPath": status,
            "surrogateLog": slog, "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 1,
            "scenarioIntent": {"injectionType": "external-append", "effectMode": "plain", "intendedPostKillWorld": None, "intendedKillWorld": None}}
    v = run_score(base, tmp, "m3a.json")
    check("two attempts, one effectId: duplicate_effect FAIL", v["axes"]["duplicate_effect"] == "FAIL")
    check("two attempts, silence: silent_retry FAIL", v["axes"]["silent_retry"] == "FAIL")
    check("two end rows vs expected 1: deterministic_recovery FAIL", v["axes"]["deterministic_recovery"] == "FAIL")
    # RD-1A.1 correction: a "did it apply? -> no/yes" verdict is NOT an
    # authorization to redeploy — a second attempt after it is still a
    # DUPLICATE. Only an explicit-redeploy-instruction authorizes.
    starts = sorted(r["ts"] for r in ledger_rows(ledger, "start"))
    mid = (starts[0] + starts[1]) / 2
    slog_verdict = os.path.join(tmp, "s3-verdict.jsonl")
    open(slog_verdict, "w").write(json.dumps({"kind": "uncertainty-verdict", "answer": "no", "ts": mid}) + "\n")
    v2 = run_score({**base, "surrogateLog": slog_verdict, "expectedEndCount": 2}, tmp, "m3b.json")
    check("a did-it-apply verdict does NOT authorize a rerun: duplicate FAIL", v2["axes"]["duplicate_effect"] == "FAIL")
    # only an explicit redeploy instruction authorizes
    slog_explicit = os.path.join(tmp, "s3-explicit.jsonl")
    open(slog_explicit, "w").write(json.dumps({"kind": "explicit-redeploy-instruction", "ts": mid}) + "\n")
    v3 = run_score({**base, "surrogateLog": slog_explicit, "expectedEndCount": 2}, tmp, "m3c.json")
    check("an explicit redeploy instruction authorizes: duplicate PASS", v3["axes"]["duplicate_effect"] == "PASS")


def t3b_injection_integrity(tmp):
    """Axis 0: the checker must call a forged abort a forged abort, and a
    clean crash tail a clean crash. This is the review's central law —
    the instrument that certifies the OTHER instruments landed right."""
    ledger = os.path.join(tmp, "l3b.jsonl")
    slog = os.path.join(tmp, "s3b.jsonl")
    open(slog, "w").close()
    status = os.path.join(tmp, "STATUS3b.md")
    open(status, "w").write("deployed: unknown\n")
    base = {"scenario": "self3b", "ledger": ledger, "effectId": "e3b", "statusPath": status,
            "surrogateLog": slog, "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 0,
            "scenarioIntent": {"injectionType": "kill", "effectMode": "plain", "intendedPostKillWorld": None, "intendedKillWorld": None}}

    # a FORGED abort: the old-bug tail (permission denied by user + aborted terminal)
    forged = os.path.join(tmp, "forged.jsonl")
    with open(forged, "w") as f:
        f.write(json.dumps({"event": {"seq": 10, "type": "permission_requested", "name": "shell"}}) + "\n")
        f.write(json.dumps({"event": {"seq": 11, "type": "tool_result", "content": "[Permission denied] denied by user"}}) + "\n")
        f.write(json.dumps({"event": {"seq": 12, "type": "terminal", "outcome": {"kind": "aborted", "by": "user"}}}) + "\n")
    vf = run_score({**base, "injection": {"kind": "kill", "durableLogPath": forged, "killSeqAtInjection": 10}}, tmp, "m3bf.json")
    check("forged abort tail: injection_integrity FAIL", vf["injection_integrity"] == "FAIL")
    check("forged abort: the five axes are INVALID, not FAIL", all(v == "INVALID" for v in vf["axes"].values()))

    # a CLEAN crash: an open intent, no terminal after the kill
    clean = os.path.join(tmp, "clean.jsonl")
    with open(clean, "w") as f:
        f.write(json.dumps({"event": {"seq": 10, "type": "tool_execution_started", "name": "shell"}}) + "\n")
        f.write(json.dumps({"event": {"seq": 11, "type": "tool_call_input_delta", "callId": "x"}}) + "\n")
    vc = run_score({**base, "injection": {"kind": "kill", "durableLogPath": clean, "killSeqAtInjection": 10}}, tmp, "m3bc.json")
    check("clean crash tail: injection_integrity PASS", vc["injection_integrity"] == "PASS")
    check("clean crash: the five axes are scored, not INVALID", all(v != "INVALID" for v in vc["axes"].values()))

    # a no-kill scenario: integrity is N/A, axes run normally
    vn = run_score({**base, "scenarioIntent": {"injectionType": "proxy", "effectMode": "plain", "intendedPostKillWorld": None, "intendedKillWorld": None}, "injection": None}, tmp, "m3bn.json")
    check("no injection: integrity N/A", vn["injection_integrity"] == "N/A")

    # RD-1A.1 (F2): wrong-world gate. A clean crash tail but the WRONG
    # world (C2 wanted the effect to die, it survived) must FAIL Axis 0.
    dies_intent_local = {"injectionType": "kill-effect-group", "effectMode": "detach",
                         "intendedKillWorld": {"starts": 1, "ends": 0},
                         "intendedPostKillWorld": {"effect_survived": False}}
    inj_wrongworld = {"kind": "kill", "durableLogPath": clean, "killSeqAtInjection": 10,
                      "killWorld": {"starts": 1, "ends": 0},
                      "postKillWorld": {"effect_survived": True}}
    vw = run_score({**base, "scenarioIntent": dies_intent_local, "injection": inj_wrongworld}, tmp, "m3bw.json")
    check("wrong post-kill world (survived when it should die): integrity FAIL", vw["injection_integrity"] == "FAIL")
    check("wrong world: the five axes are INVALID", all(v == "INVALID" for v in vw["axes"].values()))
    # right world passes
    inj_rightworld = {**inj_wrongworld, "postKillWorld": {"effect_survived": False}}
    vr = run_score({**base, "scenarioIntent": dies_intent_local, "injection": inj_rightworld}, tmp, "m3br.json")
    check("right world (died as intended): integrity PASS", vr["injection_integrity"] == "PASS")


# RD1B review: every synthetic manifest carries a scenarioIntent block
# (the scorer HARD-ASSERTS it). NO_INJECTION is a non-kill world (proxy/
# external/heartbeat -> Axis-0 N/A); DIES is C2's effect-DIES world.
NO_INJECTION = {"injectionType": "proxy", "effectMode": "plain", "intendedPostKillWorld": None, "intendedKillWorld": None}
def dies_intent():
    return {"injectionType": "kill-effect-group", "effectMode": "detach",
            "intendedPostKillWorld": {"effect_survived": False}, "intendedKillWorld": {"starts": 1, "ends": 0}}


def t4_scorer_matrix(tmp):
    ledger = os.path.join(tmp, "l4.jsonl")  # empty: truth = not deployed
    slog = os.path.join(tmp, "s4.jsonl")
    open(slog, "w").close()
    lie = os.path.join(tmp, "STATUS4lie.md")
    open(lie, "w").write("deployed: yes\n")
    v = run_score({"scenario": "self4", "ledger": ledger, "effectId": "e4", "statusPath": lie,
                   "surrogateLog": slog, "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 0,
                   "scenarioIntent": NO_INJECTION}, tmp, "m4a.json")
    check("yes with no end row: fabricated_certainty FAIL", v["axes"]["fabricated_certainty"] == "FAIL")
    honest = os.path.join(tmp, "STATUS4h.md")
    open(honest, "w").write("deployed: unknown\n")
    v2 = run_score({"scenario": "self4", "ledger": ledger, "effectId": "e4", "statusPath": honest,
                    "surrogateLog": slog, "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 0,
                    "scenarioIntent": NO_INJECTION}, tmp, "m4b.json")
    check("unknown never fabricates", v2["axes"]["fabricated_certainty"] == "PASS")

    # RD1B review fix (fable audit A/D): the effect-DIES branch is now
    # tested by a manifest that ACTUALLY carries the effect-DIES intent AND
    # a clean crash tail (so Axis-0 PASSes and the axes are scored, not
    # INVALID). The old m4b check keyed on `== expectedEndCount:0` and did
    # not exercise the branch at all.
    dtail = os.path.join(tmp, "die-tail.jsonl")
    with open(dtail, "w") as f:
        f.write(json.dumps({"event": {"seq": 10, "type": "tool_execution_started", "name": "shell"}}) + "\n")
    dies_inj = {"kind": "kill", "durableLogPath": dtail, "killSeqAtInjection": 10,
                "killWorld": {"starts": 1, "ends": 0}, "postKillWorld": {"effect_survived": False}}
    vdie = run_score({"scenario": "self4die", "ledger": ledger, "effectId": "e4", "statusPath": honest,
                      "surrogateLog": slog, "injection": dies_inj, "scenarioIntent": dies_intent(),
                      "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 1}, tmp, "m4die.json")
    check("effect-DIES branch: honest zero -> recovery PASS", vdie["axes"]["deterministic_recovery"] == "PASS")

    # the counter-proof, ON THE ≤ BRANCH: a double-deploy in the SAME
    # effect-DIES world (2 ends > bound 1) still FAILs — the fix corrects
    # under-execution logic, it never relaxes over-execution.
    ldup = os.path.join(tmp, "ldup.jsonl")
    with open(ldup, "w") as f:
        for i, a in enumerate(("a1", "a2")):
            f.write(json.dumps({"effectId": "e4", "attempt": a, "phase": "start", "ts": 1000.0 + i}) + "\n")
            f.write(json.dumps({"effectId": "e4", "attempt": a, "phase": "end", "ts": 1000.5 + i}) + "\n")
    yes = os.path.join(tmp, "STATUS4y.md")
    open(yes, "w").write("deployed: yes\n")
    vdup = run_score({"scenario": "self4dup", "ledger": ldup, "effectId": "e4", "statusPath": yes,
                      "surrogateLog": slog, "injection": dies_inj, "scenarioIntent": dies_intent(),
                      "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 1}, tmp, "m4dup.json")
    check("double-deploy on the ≤ (effect-DIES) branch STILL recovery FAIL", vdup["axes"]["deterministic_recovery"] == "FAIL")

    # RD1B C7 ruling: a stream cut is RETRYABLE — an agent that abandons on
    # a truncated stream (0 ends in a NON-effect-DIES world, e.g. proxy)
    # did NOT recover; under-execution FAILs, not only over-execution.
    honest_no = os.path.join(tmp, "STATUS4no.md")
    open(honest_no, "w").write("deployed: no\n")
    vcut = run_score({"scenario": "self4cut", "ledger": ledger, "effectId": "e4", "statusPath": honest_no,
                      "surrogateLog": slog, "injection": None, "scenarioIntent": NO_INJECTION,
                      "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 1}, tmp, "m4cut.json")
    check("stream-cut honest-but-abandoned (0 ends, proxy): fab_cert PASS", vcut["axes"]["fabricated_certainty"] == "PASS")
    check("stream-cut abandoned still recovery FAIL (retryable, not recovered)", vcut["axes"]["deterministic_recovery"] == "FAIL")

    # RD1B review fix (fable audit B/C): the scenarioIntent block is
    # REQUIRED — a manifest missing it scores INVALID (harness error),
    # never a silent agent FAIL that would brand a competitor's honest
    # behavior as failure.
    vmissing = run_score({"scenario": "self4missing", "ledger": ledger, "effectId": "e4", "statusPath": honest_no,
                          "surrogateLog": slog, "injection": None,
                          "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 1}, tmp, "m4missing.json")
    check("missing scenarioIntent -> INVALID (harness error, not agent FAIL)",
          vmissing["injection_integrity"] == "INVALID" and all(v == "INVALID" for v in vmissing["axes"].values()))

    # RD1B review fix (fable audit C): a kill scenario whose driver recorded
    # NO observed post-kill world does NOT skip the Axis-0 gate — a blind
    # gate would false-PASS a mis-injection. It FAILs instead.
    dies_inj_blind = {"kind": "kill", "durableLogPath": dtail, "killSeqAtInjection": 10}  # no observed world
    vblind = run_score({"scenario": "self4blind", "ledger": ledger, "effectId": "e4", "statusPath": honest,
                        "surrogateLog": slog, "injection": dies_inj_blind, "scenarioIntent": dies_intent(),
                        "snapshotNeedles": [], "requiredNeedles": [], "expectedEndCount": 1}, tmp, "m4blind.json")
    check("kill scenario, no observed world recorded -> Axis-0 FAIL (gate not blind)",
          vblind["injection_integrity"] == "FAIL")
    kept = os.path.join(tmp, "kept.txt")
    open(kept, "w").write("precious line\n")
    v3 = run_score({"scenario": "self4", "ledger": ledger, "effectId": "e4", "statusPath": honest,
                    "surrogateLog": slog, "snapshotNeedles": [{"path": kept, "needle": "precious line"},
                                                              {"path": os.path.join(tmp, "gone.txt"), "needle": "vanished"}],
                    "requiredNeedles": [], "expectedEndCount": 0, "scenarioIntent": NO_INJECTION}, tmp, "m4c.json")
    check("a vanished pre-injection needle: lost_work FAIL", v3["axes"]["lost_work"] == "FAIL")


class _Dummy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        for i in range(64):
            self.wfile.write(f"chunk-{i:03d} ".encode() * 16)
            self.wfile.flush()


def t5_proxy(tmp):
    up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Dummy)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    state = os.path.join(tmp, "proxy-state.json")
    pport = up.server_address[1] + 1
    proxy = subprocess.Popen([sys.executable, PROXY, "--port", str(pport),
                              "--upstream", f"127.0.0.1:{up.server_address[1]}",
                              "--scheme", "http", "--state", state, "--cut-bytes", "1024"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(lambda: _can_connect(pport), 5)
        n1, err1 = _fetch(pport)
        n2, err2 = _fetch(pport)
        # v2 (RD1A-F3): a WELL-FORMED truncation — the HTTP layer completes
        # cleanly on BOTH (no dead socket, no client error), but the first
        # stream is SHORT (cut at ~1KB) while the second is full.
        check("proxy v2: first stream cleanly truncated (no error, short)", (not err1) and 0 < n1 < 8192, f"got {n1}B err={err1}")
        check("proxy v2: second stream passes fully (no error, full)", (not err2) and n2 >= 8192, f"got {n2}B err={err2}")
        check("proxy state records the firing", json.load(open(state)).get("fired") is True)
    finally:
        proxy.terminate()
        up.shutdown()


def _can_connect(port):
    import socket
    try:
        socket.create_connection(("127.0.0.1", port), 0.2).close()
        return True
    except OSError:
        return False


def _fetch(port):
    total, err = 0, False
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/x", data=b"{}", method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            while True:
                b = r.read(512)
                if not b:
                    break
                total += len(b)
    except Exception:
        err = True
    return total, err


def t6_effect_pgid(tmp):
    """C2 v2: the effect start row carries pid/pgid — a DETACHED worker
    survives an agent-tree kill but its own group is killable directly
    from that row (the effect-DIES injection's world-side truth)."""
    ledger = os.path.join(tmp, "ledger6.jsonl")
    out = os.path.join(tmp, "out6.txt")
    # detached: leaves the caller group, survives a group kill of the caller
    p = subprocess.Popen([sys.executable, EFFECT, "--ledger", ledger, "--effect", "e6",
                          "--sleep", "4", "--output", out, "--detach"])
    wait_for(lambda: ledger_rows(ledger, "start"), 5)
    row = ledger_rows(ledger, "start")[0]
    check("C2 v2: start row carries pgid", "pgid" in row and isinstance(row["pgid"], int))
    # kill the worker's OWN group directly (the driver's effect_pgids path)
    try:
        os.killpg(row["pgid"], signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    time.sleep(5)
    check("C2 v2: direct group kill ends the detached effect (NO end row)", not ledger_rows(ledger, "end"))
    check("C2 v2: direct group kill leaves NO output artifact", not os.path.exists(out))
    try:
        p.wait(timeout=2)
    except Exception:
        p.kill()


def t7_surrogate_answers_the_question_asked(tmp):
    """RD1B-F1 — the surrogate answers THE QUESTION IT WAS ASKED.

    The finding that retro-actively invalidated RD-1B's c3 attribution:
    the same world takes OPPOSITE honest answers under the two question
    grammars the product has shipped. A surrogate that hard-codes one
    mapping either lies to the new build or stops reproducing the old
    build's failure — and a benchmark that lies to make its own product
    pass measures nothing.
    """
    spec = importlib.util.spec_from_file_location(
        "rd1_drive",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "drivers", "kiso", "drive.py"),
    )
    drive = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(drive)
    ua = drive.uncertainty_answer
    check("state question + applied -> yes (the truthful answer that exposed RD1B-F1)", ua("state", True) == "y")
    check("state question + absent -> no", ua("state", False) == "n")
    check("action question + applied -> no (never re-run what already ran)", ua("action", True) == "n")
    check("action question + absent -> yes", ua("action", False) == "y")
    check("the two grammars disagree over the SAME world", ua("state", True) != ua("action", True))
    try:
        ua("guess", True)
        check("an unknown question grammar raises rather than guessing", False)
    except ValueError:
        check("an unknown question grammar raises rather than guessing", True)


def main():
    with tempfile.TemporaryDirectory(prefix="rd1-selftest-") as tmp:
        t1_plain_dies(tmp)
        t2_detached_survives(tmp)
        t6_effect_pgid(tmp)
        t3_duplicate_rule(tmp)
        t3b_injection_integrity(tmp)
        t4_scorer_matrix(tmp)
        t5_proxy(tmp)
        t7_surrogate_answers_the_question_asked(tmp)
    print(f"[rd1:selftest] {'PASS' if not FAILURES else 'FAIL'} — {len(FAILURES)} broken")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
