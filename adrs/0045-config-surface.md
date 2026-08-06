# ADR-0045: The config surface — three rulings, one schema

- **Status:** Accepted
- **Date:** 2026-08-06
- **Layer:** CLI (the config layer), runtime lightly touched (the adapter
  factory + the trust package)

## Context

The CLI's configuration lived in environment variables only. The bench
rounds kept the kiso-ds wrapper pattern (a shell wrapper exporting
OPENAI_* vars) as the documented way to use DeepSeek — workable but
untyped, per-project-file, and impossible to switch mid-session. The
config surface must: hold named model profiles, respect a strict
precedence (flags > env > project > user > default), survive broken JSON
loudly, and never become a place where credentials live.

## Decision — the three rulings

1. **Credentials never land in a config file.** A profile stores only the
   apiKeyEnv NAME (the env var holding the key). An unset env marks the
   profile UNAVAILABLE — listed as such in /model, refused loudly on
   switch, never a crash and never a silent fallback. A config file is
   therefore safe to share, commit, or paste into a review thread.
2. **The project config is an artifact of the E3 trust package.**
   `<cwd>/.kiso/config.json` joins extensions/mcp.json/skills in the
   content-digest gate: trusting the package trusts its config, an
   untrusted project's config is never even read, and a changed config is
   a changed digest (the trust decision re-evaluates). The trust gate's
   own policy key (projectTrust) is read from the USER config only —
   "ask" (the E3 gate, default) or "never" (auto-refuse, nothing loads).
   There is deliberately **no "always"**: auto-trusting a project's
   capability without a human decision would hollow out the digest gate.
3. **Precedence: flags > env > project config > user config > defaults.**
   Env vars remain first-class (they are the fastest way to run one
   command with a different model); the config fills the layers below
   them. --model names a profile or writes provider/model directly; an
   invalid KISO_MODE / invalid env value behaves like the layer abstaining
   (env wins over config, even when it is invalid — for autoCompact an
   invalid env is OFF).

## Schema v1

```jsonc
{
  "model": "deepseek | openai-compat/gpt-4o",   // profile name or provider/model
  "models": {
    "deepseek": { "kind": "openai-compat", "model": "deepseek-v4-flash",
                  "apiKeyEnv": "DEEPSEEK_API_KEY", "baseUrl": "https://..." }
  },
  "mode": "manual | default | accept-edits | plan | bypass",
  "contextWindow": 160000,          // tokens; env KISO_CONTEXT_WINDOW wins
  "autoCompact": { "thresholdRatio": 0.8 },  // env KISO_AUTO_COMPACT wins
  "projectTrust": "ask | never"
}
```

Unknown top-level keys pass (forward compatibility); a known key with an
invalid value fails LOUDLY (file + reason, non-zero exit) — a silently
ignored config would mislead. The project config's mode applies after the
trust gate (its verdict decides whether the project config exists at all),
unless a higher layer already decided.

## Consequences

- `/model` lists profiles with availability annotations and switches the
  session's adapter for subsequent turns (session.setAdapter — the kernel
  reads the adapter through the loop-config closure per turn, so the swap
  is a runtime light touch; the current run keeps its adapter).
- The kiso-ds wrapper pattern remains supported as a legacy form (the
  env path is still first in the chain); the README migration section
  shows the config-profile form as the replacement.
- The runtime changes are deliberately minimal: `buildAdapter` exported
  (the CLI never imports provider SDKs directly), `AgentSession.setAdapter`,
  and the trust package's artifact set extended to config.json.
- The D 区 request-level contract (ADR-0026 Amendment 1) is unaffected:
  the system prompt does not read config at request time.
