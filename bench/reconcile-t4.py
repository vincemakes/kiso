#!/usr/bin/env python3
"""T4 失格调查 — per-request reconciliation of a kiso run from a
KISO_DUMP_REQUESTS directory (bench/README, the debug sink the 0.1.23
fresh-mystery built): one req-<pid>-<n>.json per API request, in order.

Emits, per request:
  N: messages=<count> last=<role> calls=[<tool> <input>…]

and for request 1: whether the skills index line (the two-tier skills
extension's system-prompt append) is present — the T4 structural question
is whether the model USES read_skill or walks .claude/skills physically.

Usage: python3 reconcile-t4.py <dump-dir>
"""
import json, sys, glob, re

def main():
    dump = sys.argv[1]
    files = sorted(glob.glob(f"{dump}/req-*.json"), key=lambda f: int(re.search(r"-(\d+)\.json$", f).group(1)))
    if not files:
        print("no requests found"); return
    for i, f in enumerate(files, 1):
        body = json.load(open(f))
        msgs = body.get("messages", [])
        # The tool_calls live in the LAST ASSISTANT message (the request may
        # end with its tool messages).
        calls = []
        for m in reversed(msgs):
            for tc in m.get("tool_calls", []) or []:
                fn = tc.get("function", {})
                name = fn.get("name", "?")
                args = fn.get("arguments", "")
                try:
                    inp = json.loads(args) if args else {}
                except json.JSONDecodeError:
                    inp = {"<raw>": args[:40]}
                inp_s = " ".join(f"{k}={str(v)[:38]}" for k, v in inp.items())
                calls.append(f"{name}({inp_s})")
            if m.get("tool_calls"):
                break
        line = f"{i:>2}: messages={len(msgs):<3} " + (" ".join(calls) if calls else "-")
        if i == 1 and msgs:
            sp = msgs[0].get("content", "")
            has_index = "Available skills" in sp if isinstance(sp, str) else False
            line += f"  [skills-index-line: {'present' if has_index else 'absent'}]"
        print(line)

if __name__ == "__main__":
    main()
