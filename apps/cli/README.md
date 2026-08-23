# @vincemakes/kiso-code

The coding agent that survives kill -9: durable sessions (append-only
JSONL), pre-effect approvals, and honest recovery — an interrupted side
effect is surfaced and asked about, never silently re-run.

## Install and first session

```sh
npm install -g @vincemakes/kiso-code
kiso                    # or: npx @vincemakes/kiso-code
```

With no key set you get **faux mode** — a scripted four-round demo of
the full CLI (tools, approvals, sessions), zero keys. When the script
runs out (about two user turns) the session exits with a set-a-key
message; that exit is the design, not a crash.

## A real model

```sh
# OpenAI-compatible (checked first; the key alone talks to OpenAI —
# OPENAI_BASE_URL optionally retargets DeepSeek or any compat endpoint):
export OPENAI_API_KEY=...      # OPENAI_MODEL (default gpt-4o)

# or Anthropic:
export ANTHROPIC_API_KEY=...   # ANTHROPIC_MODEL (default claude-sonnet-5)

kiso
```

Named model profiles live in `~/.kiso/config.json` (the config stores
the NAME of the env var holding each key, never the key itself); switch
in-session with `/model`. Approval tiers: `--mode
manual|default|accept-edits|plan|bypass` or `/mode` in-session.

## The commands

```text
kiso [sessionId]             interactive session (default command)
kiso resume                  pick a session to continue (TTY picker)
kiso resume <id> ["prompt"]  continue a session, one-shot
kiso sessions                list durable sessions
kiso help                    usage + configuration reference
```

Sessions live under `~/.kiso/sessions`; kill the process — `kill -9`
included — and `kiso resume` continues exactly where the log ends.

**Platforms:** macOS / Linux (Node ≥ 22). Windows is unsupported.

Full documentation — extensions (MCP, skills, subagents), the approval
model, session recovery, configuration reference — in the
[repository README](https://github.com/vincemakes/kiso#readme).
