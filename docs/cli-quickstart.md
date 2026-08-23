# CLI quickstart — five minutes to a working session

This page is for the CLI product (`kiso`). Embedding kiso as a library
is a different walkthrough: `docs/getting-started.md`.

## 1. Install (30 seconds)

```sh
npm install -g @vincemakes/kiso-code
kiso        # or, without installing: npx @vincemakes/kiso-code
```

Requirements: Node ≥ 22, macOS or Linux (Windows is unsupported).

## 2. What the first run does

- If the working directory contains a `.kiso/` directory, the FIRST
  thing you see is the project-trust question (ADR-0037): project-local
  config and extensions load only after you approve them, and the
  approval is remembered by content digest.
- A `~/.kiso/config.json` is scaffolded silently (`{"models": {}}`).
- With no API key you are in **faux mode** — a scripted four-round demo
  of the real CLI (tools run, approvals ask, the session persists).
  After about two user turns the script is exhausted and the process
  exits non-zero with a set-a-key message. That exit is the design.

## 3. Connect a real model

Fastest — environment variables only:

```sh
# OpenAI-compatible (checked FIRST when both keys are set):
export OPENAI_API_KEY=...
export OPENAI_MODEL=gpt-4o            # optional; this is the default
export OPENAI_BASE_URL=https://api.deepseek.com   # optional: any compat endpoint

# or Anthropic:
export ANTHROPIC_API_KEY=...
export ANTHROPIC_MODEL=claude-sonnet-5   # optional; this is the default
```

Durable — named profiles in `~/.kiso/config.json` (the config stores
the NAME of the env var that holds each key — never the key):

```jsonc
{
  "model": "ds",
  "models": {
    "ds":     { "kind": "openai-compat", "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "claude": { "kind": "anthropic", "model": "claude-sonnet-5",
                "apiKeyEnv": "ANTHROPIC_API_KEY" }
  }
}
```

Precedence: `--model` flag > env keys > project config > user config >
faux. Switch mid-session with `/model` (a picker on a bare `/model`).

## 4. The session loop

```text
kiso                     new session (id = timestamp)
/help                    commands; ? on an empty composer shows the keys
/mode accept-edits       approval tier (manual|default|accept-edits|plan|bypass)
/compact                 summarize the older conversation (durable, cancellable)
/context                 where the context window went, per request
exit  (or Ctrl+D)        leave — the session is durable either way
```

Under the DEFAULT tier, write/edit/shell calls pause for approval
first (a diff card for edits); the other tiers move that line —
`manual` asks for every tool, `accept-edits` auto-allows writes and
edits (shell still asks), `plan` refuses everything but reads, `bypass`
allows everything. "Don't ask again for X" writes a human-editable rule
to `~/.kiso/extensions/dont-ask-again.mjs` — delete the file to revoke.

## 5. Kill it and come back

```sh
kiso sessions            # badge cards: ✓ completed · ▌ interrupted · ? uncertain
kiso resume              # TTY picker; Enter resumes recovery one-shot
kiso <sessionId>         # reopen the full interactive session
```

`kill -9` mid-run is the designed case, not the edge case: the log is
write-ahead, an interrupted side effect is surfaced as `⚠ interrupted
execution` and asked about — a confirmed success is never re-run.

## 6. Extensions in one line each

- **MCP servers** — `~/.kiso/mcp.json` (see the README's MCP section).
- **Skills** — drop `<name>/SKILL.md` under `~/.kiso/skills/`
  (Claude-Code-compatible frontmatter; symlinks work).
- **Subagents** — the built-in `delegate` tool runs child kiso
  processes; nothing to configure.
- **Your own** — a `*.mjs` default export under `~/.kiso/extensions/`.
