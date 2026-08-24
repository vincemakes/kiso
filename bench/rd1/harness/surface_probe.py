#!/usr/bin/env python3
"""RD1B-F7 surface decomposition — what each agent SENDS, before any task.

RD-1B measured a fixed 2,620-token gap on the first request of every
cell and the batch read it as an architectural property. It is a NET
BASELINE GAP under unequal environments, and nobody had decomposed it.

This decomposes it by DIFFERENCING conditions, reading each agent's own
reported first-request prompt tokens — the identical metric that
produced the contaminated 2,371-vs-4,991 figures, so the results are
directly comparable to them.

A local recording proxy was tried first and abandoned: pi honours
neither DEEPSEEK_BASE_URL nor OPENAI_BASE_URL and connects to the real
endpoint regardless (the same non-retargetability that got C7 excluded
for pi in RD-1B). Measuring one arm through a proxy and the other
through the real endpoint would reintroduce exactly the asymmetry this
probe exists to remove, so both arms use the real endpoint with a
trivial prompt. Cost is a few cents.

The composition comes from the DIFFS, not from parsing prompts:
pi+skills minus pi-clean is the skills index, whatever it is named
inside the prompt and however it is formatted.

Isolation is symmetric, which RD-1B's was not. Every child gets a
CLEARED environment plus one identical whitelist (the pi driver called
os.environ.update without clear(), so it inherited the operator's whole
shell). Every agent gets its own empty profile directory. The fixture
lives outside the repository, so no ancestor instruction file is
reachable by an agent that walks upward.

usage: surface_probe.py --kiso-cli <path> --out <dir>
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import tempfile


def whitelist_env(extra):
    """A CLEARED environment plus one identical whitelist, both arms.

    RD-1B's kiso driver did os.environ.clear() before update() and the
    pi driver did not, so one arm ran on an 8-key whitelist and the
    other inherited the operator's whole shell. Both start from nothing
    here.
    """
    env = {
        "PATH": os.environ["PATH"],
        "TERM": "dumb",
        "OPENAI_API_KEY": os.environ["DEEPSEEK_API_KEY"],
        "DEEPSEEK_API_KEY": os.environ["DEEPSEEK_API_KEY"],
        "OPENAI_BASE_URL": "https://api.deepseek.com",
        "OPENAI_MODEL": "deepseek-v4-flash",
    }
    env.update(extra)
    return env


def pi_first_request(session_dir):
    """pi's own reported prompt tokens for its first assistant turn."""
    for f in sorted(glob.glob(os.path.join(session_dir, "**", "*.jsonl"), recursive=True)):
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            m = r.get("message") or {}
            u = m.get("usage")
            if u and m.get("role") == "assistant":
                if m.get("stopReason") == "error":
                    return None
                return (u.get("input") or 0) + (u.get("cacheRead") or 0)
    return None


def kiso_first_request(home):
    """kiso's trace: freshInput + cacheRead on request 0, plus the
    per-role split the contextManifest records for free."""
    for f in sorted(glob.glob(os.path.join(home, "sessions", "traces", "*.jsonl"))):
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("kind") != "request":
                continue
            split = {m["role"]: m["estTokens"] for m in r.get("contextManifest", [])}
            return (r.get("freshInput") or 0) + (r.get("cacheRead") or 0), split
    return None, {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kiso-cli", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="deepseek-v4-flash")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    # The fixture lives OUTSIDE the repository, so nothing upward is
    # reachable by an agent that walks ancestors for context files.
    root = tempfile.mkdtemp(prefix="rd1-surface-")
    fixture = os.path.join(root, "fixture")
    os.makedirs(fixture)
    open(os.path.join(fixture, "NOTES.md"), "w").write("# notes\n\nversion: v1\n")
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))
    repo_claude = os.path.join(repo_root, "CLAUDE.md")
    assert os.path.exists(repo_claude), repo_claude
    real_skills = os.path.expanduser("~/.pi/agent/skills")
    PROMPT = "Reply with exactly: ok"

    def ancestor_claude(on):
        target = os.path.join(root, "CLAUDE.md")   # the fixture's PARENT
        if on:
            shutil.copyfile(repo_claude, target)
        elif os.path.exists(target):
            os.unlink(target)

    rows, notes = {}, {}

    def run_pi(label, skills, ancestor):
        ancestor_claude(ancestor)
        d = tempfile.mkdtemp(prefix="pi-agent-", dir=root)
        if skills:
            shutil.copytree(real_skills, os.path.join(d, "skills"))
        sess = os.path.join(d, "sessions")
        argv = ["pi", "--provider", "deepseek", "--model", a.model, "-p", "--mode", "json",
                "--session-dir", sess, "-ne"]
        if not skills:
            argv.append("-ns")
        if not ancestor:
            argv.append("-nc")
        argv.append(PROMPT)
        env = whitelist_env({"HOME": d, "PI_CODING_AGENT_DIR": d,
                             "PI_CODING_AGENT_SESSION_DIR": sess})
        r = subprocess.run(argv, env=env, cwd=fixture, capture_output=True, text=True, timeout=180)
        rows[label] = pi_first_request(sess)
        if rows[label] is None:
            notes[label] = (r.stdout or r.stderr or "")[-200:]
        ancestor_claude(False)

    def run_kiso(label, cwd_claude):
        target = os.path.join(fixture, "CLAUDE.md")
        if cwd_claude:
            shutil.copyfile(repo_claude, target)
        elif os.path.exists(target):
            os.unlink(target)
        h = tempfile.mkdtemp(prefix="kiso-home-", dir=root)
        env = whitelist_env({"HOME": h, "KISO_HOME": h, "KISO_MODE": "bypass"})
        r = subprocess.run(["node", a.kiso_cli, "chat", label], env=env, cwd=fixture,
                           input=PROMPT + "\nexit\n", text=True, capture_output=True, timeout=180)
        total, split = kiso_first_request(h)
        rows[label] = total
        if total is None:
            notes[label] = (r.stdout or r.stderr or "")[-200:]
        else:
            notes[label] = "split: " + ", ".join(f"{k}={v}" for k, v in split.items())
        if os.path.exists(target):
            os.unlink(target)

    run_pi("pi-clean", skills=False, ancestor=False)
    run_pi("pi-skills", skills=True, ancestor=False)
    run_pi("pi-claudemd", skills=False, ancestor=True)
    run_pi("pi-both", skills=True, ancestor=True)
    run_kiso("kiso-clean", cwd_claude=False)
    run_kiso("kiso-claudemd", cwd_claude=True)

    json.dump({"rows": rows, "notes": notes}, open(os.path.join(a.out, "surface.json"), "w"),
              indent=1, sort_keys=True)

    print(f"\n{'condition':16s} {'first-request prompt tokens':>28s}")
    for k in ("pi-clean", "pi-skills", "pi-claudemd", "pi-both", "kiso-clean", "kiso-claudemd"):
        v = rows.get(k)
        print(f"{k:16s} {(f'{v:,}' if v is not None else 'NO MEASUREMENT'):>28s}"
              + (f"   [{notes[k]}]" if k in notes and v is not None else ""))
    print()
    if rows.get("pi-clean") and rows.get("pi-skills"):
        print(f"  the 13 skills index   = pi-skills   − pi-clean = "
              f"{rows['pi-skills'] - rows['pi-clean']:+,} tokens")
    if rows.get("pi-clean") and rows.get("pi-claudemd"):
        print(f"  ancestor CLAUDE.md    = pi-claudemd − pi-clean = "
              f"{rows['pi-claudemd'] - rows['pi-clean']:+,} tokens")
    if rows.get("pi-clean") and rows.get("pi-both"):
        print(f"  both together         = pi-both     − pi-clean = "
              f"{rows['pi-both'] - rows['pi-clean']:+,} tokens")
    if rows.get("pi-clean") and rows.get("kiso-clean"):
        d = rows["pi-clean"] - rows["kiso-clean"]
        print(f"\n  CLEANED BASELINE      = pi-clean    − kiso-clean = {d:+,} tokens"
              f"   ({'pi larger' if d > 0 else 'kiso larger' if d < 0 else 'equal'})")
        print(f"  for reference, RD-1B's contaminated gap was            +2,620 tokens")
    shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
