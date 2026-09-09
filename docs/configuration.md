# Configuration — requirements, models, effort, and credentials

Where a model comes from, how a credential is stored, and what the
config file may say. The README's "Sign in" and "Models and effort"
sections are the short form of this page.

## Requirements

- **Node ≥ 22** (the packages' engines).
- **macOS / Linux.** Windows is unsupported: the shell tool's process
  groups, the session-lock liveness probe (`ps`), and the PTY test
  suite are all POSIX-only, and no CI runs on Windows. WSL falls under
  Linux but carries no dedicated testing.

## Support

Node **>= 22** (the OpenAI-compat provider and the CLI declare it in `engines`).

## Model configuration (`~/.kiso/config.json`, 0.1.23)

The config surface (ADR-0045) holds named model profiles — schema v1,
credentials never inside (a profile only NAMES the env var holding its
key). Precedence: **flags > env > project config > user config > default**;
a broken config file fails loudly with the file named.

```jsonc
// ~/.kiso/config.json
{
  "model": "deepseek",                       // the startup profile
  "models": {
    "deepseek": {
      "kind": "openai-compat",               // "openai-compat" | "anthropic" | "openai-responses"
      "model": "deepseek-v4-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",       // the key's env var — never the key
      "baseUrl": "https://api.deepseek.com"  // optional
    },
    "claude": {
      "kind": "anthropic",
      "model": "claude-opus-5",              // claude-fable-5-1 / claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "promptCaching": false                 // opt-in; see the first-party notes below
    }
  },
  "mode": "default",                         // manual/default/accept-edits/plan/bypass
  "contextWindow": 160000,                   // tokens
  "autoCompact": { "thresholdRatio": 0.8 },  // opt-in, env KISO_AUTO_COMPACT wins
  "projectTrust": "ask"                      // "ask" | "never" — no "always"
}
```

- `kiso --model deepseek chat` — the flag beats everything; `provider/model`
  direct writes work too (`--model openai-compat/gpt-4o`,
  `--model anthropic/claude-sonnet-5`).
- **Anthropic first-party notes (PA-1a, 0.28.0).** The current line —
  Claude Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5 — is registered with
  dated, sourced context windows, effort levels, thinking modes and
  prices (read from the docs on 2026-09-07; `/model` shows them). Effort
  (`low` … `max`) and thinking (`adaptive` / `disabled`, per model) go
  on the wire exactly as documented; Haiku 4.5's manual thinking budget
  is not driven. `promptCaching` is **off by default**: turning it on
  places two ephemeral `cache_control` breakpoints (the system prompt
  and the rolling last block) and changes the request bytes and the
  bill — cache reads cost 10% of input (2.5% on Fable 5.1), a 5-minute
  cache write 125%. The default flips only after a paired bench on a
  live Anthropic leg proves the saving; until then set it per profile.
  Finding MG1-F1 (2026-09-07): the adapter's signed and redacted
  thinking-block replay is verified against Claude Sonnet 5 through
  OpenRouter's Anthropic-format endpoint — byte-identical replays, all
  accepted; the first-party beta surface (beta headers, Fable 5.1's
  thinking-block binding) is not yet exercised directly.
- **Sign-in and the OpenAI Responses dialect (OR-1, 0.31.0).**
  `kiso login <provider>` stores a credential in `~/.kiso/auth.json`
  (mode 0600): an API key for `anthropic` / `openai` / `deepseek` /
  `zai`, the subscription OAuth sign-in for `chatgpt`. A stored
  credential OWNS its provider — an unusable stored one is a loud error,
  never a silent fall back to the env var; `kiso logout <provider>`
  removes it, `kiso auth` lists them masked. `kind: "openai-responses"`
  profiles reach the first-party API (`api.openai.com`, a key) or the
  ChatGPT subscription backend (`"baseUrl": "https://chatgpt.com/backend-api"`,
  no `apiKeyEnv`, `kiso login chatgpt`). gpt-5.5 and gpt-5.4 are
  registered at BOTH endpoints, dated and sourced: `/model` shows each
  profile's legal effort levels; a subscription run is priced `null` (a
  subscription is not billed per token) and measured against the presets'
  272,000 window; a level the backend lacks is refused by name at `/model`
  and again by the run itself. Verification status, stated plainly: the
  DeepSeek credential-store path has a real leg (2026-09-08); the Responses
  adapter — both targets — is **offline-verified** against its byte rigs
  and **pending real-integration acceptance** (the package README's
  support-level table says `unrun` until a real leg lands). Anthropic
  stays API-key: the vendor prohibits third-party subscription sign-in.
- `/model` in a session lists the profiles (each annotated available /
  unavailable — an unset apiKeyEnv is never a crash) and switches the
  session's adapter for subsequent turns (a NoticeCell records it).
- A profile whose env var is unset is refused loudly on switch — configs
  never store keys, so a missing env is an honest "not configured".
- The project's own `.kiso/config.json` rides the E3 trust gate: a
  granted project's config applies, an untrusted one is never even read
  (its digest covers the config file).
- **Migration from the kiso-ds wrapper pattern** (a shell wrapper
  exporting `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`): the
  wrapper still works — the env layer is second in the chain — but the
  config profile above is the replacement form (typed, switchable at
  runtime, and the key stays in your environment either way). The wrapper
  pattern is legacy, supported.
