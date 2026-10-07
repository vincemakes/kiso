# Configuration — requirements, models, effort, and credentials

Where a model comes from, how a credential is stored, and what the
config file may say. The README's "Sign in" and "Models and effort"
sections are the short form of this page.

## Requirements

- **Node ≥ 22** (the packages' engines).
- **macOS / Linux.** Windows is not yet supported: npm refuses the
  install there (the package's `os` field). The library's Windows paths
  — commands through Git Bash, process trees ended with `taskkill`, the
  session store's writes — run in a Windows CI job, but the terminal has
  not been checked on a real Windows machine, and a power loss there can
  drop a file created just before it ([durability](durability.md)). WSL
  falls under Linux but carries no dedicated testing.

## Support

Node **>= 22** (the OpenAI-compat provider and the CLI declare it in `engines`).

**After an upgrade, restart the sessions that were open.** A running
session keeps the code it started with; `kiso --version` in another shell
prints the version on disk, not the one the session runs. Since 0.40.5 a
session notices: after a turn it says once `✦ kiso <new> is installed —
this session runs <old>; exit and resume it (kiso resume <id>) to use it`,
and `/status` names both versions until it is restarted.

**What is in force, and why (0.40.6).** `/settings` in a session lists
each setting — the model, the mode, the theme, the floor, the window,
compaction, project trust, the thinking display, the version — with its
current value, the layer it came from (a flag, an environment variable,
the project config, your config, a choice remembered from `ctrl+t`, or
the default) and how to change it. It only reads: your config file stays
yours to edit.

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
    },
    "slow": {
      "kind": "openai-compat",
      "model": "some-reasoning-model",
      "baseUrl": "https://example.invalid/v1",
      "apiKeyEnv": "SLOW_KEY",
      "streamIdleMs": 300000                 // the stream watchdog: 5 min of silence before a retry (default 120 s; 0 off)
    }
  },
  "mode": "default",                         // default/accept-edits/plan/full-access
  "dontAsk": false,                          // true: never stop for a person — what would ask is refused
  "contextWindow": 160000,                   // tokens
  "autoCompact": { "thresholdRatio": 0.8 },  // opt-in, env KISO_AUTO_COMPACT wins
  "projectTrust": "ask"                      // "ask" | "never" — no "always"
}
```

- `"floor": "catastrophe" | "off"` — the catastrophe floor (on by default):
  in every mode, full access included, a destructive command whose target cannot be
  recovered is refused (see the README). USER config only — a project config
  that names `floor` fails loudly, because a repository must never lower it.
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
- **An UNREGISTERED model id keeps its defaults and refuses a level by
  name (Astra F5).** The registry never guesses. A model with no row still
  sends text — `default`/`default` resolves to an empty wire setting — but
  an explicit `low`/`high`/`max` is REFUSED, by name, rather than silently
  downgraded.

- **The context window follows the MODEL, not the address (CW-1).** The
  same few models are reachable through many endpoints — the vendor, a
  gateway, a relay, a local forwarder — and the window is a property of
  the weights: a route can cap it lower, never raise it. The window is
  resolved in this order, and `/status` and `/model` say which step
  answered:

  1. **what you set** — `KISO_CONTEXT_WINDOW`, the profile's
     `"contextWindow"`, the top-level `"contextWindow"`, in that order;
  2. **what this endpoint refused at** — a refusal such as "maximum context
     length is 131072 tokens" states the route's real cap. kiso reads it,
     compacts against it at once (`✦ window learned — …`), and keeps it in
     `~/.kiso/learned-windows.json` (per endpoint and model, only ever
     lowered) so the next session starts there. Delete the file's entry if
     the endpoint later raises its cap;
  3. **the registry's row for this endpoint** (gpt-5.5 is 1,050,000 at the
     first-party API and 272,000 at the subscription backend);
  4. **the registry's row for the profile's `"upstream"`** — a profile
     whose `baseUrl` is a local forwarder names where the forwarder sends
     its requests (`"upstream": "https://gateway.example/v1"`); `/model`
     then shows `@gateway.example via 127.0.0.1:47821`;
  5. **the model's own window**, from every row for the same model at any
     endpoint — the vendor prefix dropped, case folded, and a vendor-stated
     alias applied (`deepseek-v4.1-flash` is `deepseek-flash`). Where rows
     disagree, the smallest. `/status` says `inferred from the model` —
     no row states it for this endpoint — step 2 corrects it the first
     time the endpoint refuses.

  Nothing after step 5: an unknown model shows `ctx ?`, and compaction
  assumes a conservative **128,000 tokens** (said once at startup). For a
  model with a larger real window, relief fires earlier than it needs to;
  for a smaller one the provider can refuse a request while the meter still
  looks comfortable. Set the true number when you know it. Price, effort
  levels and max output are facts about a route and are never inferred
  this way.

- **Headers an endpoint needs (0.40.4).** `"headers"` on a profile sends
  those headers with every request to its `baseUrl` — a gateway that
  routes a conversation by a session header, say. `{session}` in a value
  becomes the kiso session's id: one conversation keeps one id across
  `/model` and `/resume`, and two conversations never share one. Names are
  case-insensitive (kept lower-case). A credential header (`authorization`,
  `proxy-authorization`, `x-api-key`, `api-key`, `cookie`) or a framing
  header (`host`, `content-type`, `content-length`, `transfer-encoding`,
  `connection`) is refused: the key comes from `apiKeyEnv` or
  `kiso login`, never from the config file.

  ```jsonc
  "gw": {
    "kind": "openai-compat",
    "model": "some-model",
    "baseUrl": "https://gateway.example/v1",
    "apiKeyEnv": "GATEWAY_KEY",
    "headers": { "x-gateway-session": "{session}" }
  }
  ```

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
- **`prompt_cache_key` is the SUBSCRIPTION target's, and only its**
  (finding IA-0360-F1). The Responses adapter adds the session id as
  `prompt_cache_key` on the ChatGPT (OAuth) target; the first-party
  API-key target sends an empty `extraBody` and no cache key, at startup
  and after `/model` alike. 0.36.0 made the two construction sites PASS
  the option identically, which is a tidiness fix and not a wire change —
  the adapter serializes it on one authentication path either way. An
  earlier draft of this paragraph announced a first-party cache lane that
  does not exist; passing an internal option at two construction sites is
  not evidence that the adapter puts it on the wire on both paths.
- The project's own `.kiso/config.json` rides the E3 trust gate: a
  granted project's config applies, an untrusted one is never even read
  (its digest covers the config file).
- **A project config can only make kiso stricter** (0.46.2). Its `mode`
  may be as strict as yours or stricter (plan, then default, then
  accept-edits, then full-access), never looser. Its `dontAsk` may turn the
  switch on, never off. It may pick one of your profiles with `model` but
  never define `models`, because a profile says where requests and your key
  go. Each of these is a loud startup error naming the file. `--mode` and
  `KISO_MODE` are your own choice and still win. A trusted project's
  extensions, checks and evaluators are code: the trust gate, not this
  rule, governs them.
- **Migration from the kiso-ds wrapper pattern** (a shell wrapper
  exporting `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`): the
  wrapper still works — the env layer is second in the chain — but the
  config profile above is the replacement form (typed, switchable at
  runtime, and the key stays in your environment either way). The wrapper
  pattern is legacy, supported.

**The stream watchdog (LT-1).** A model stream that stops writing — a hung socket, an
upstream that went quiet without closing — is ended `streamIdleMs` milliseconds after
its last event: the request is aborted and the attempt voided (a durable
`model_output_abandoned` marker per attempt), the kernel retries with backoff, and when
the retry budget is spent the run ends in an error terminal that names the stall — on
screen (`run failed — network (retryable): stream stalled: no event for 120s …`) and in
the log.
The bound is per EVENT, so a long think that keeps streaming is never touched. Default
120,000 ms; a profile may raise it for a backend that thinks silently at high effort,
or set `0` to disable the watchdog for that profile. `KISO_STREAM_IDLE_MS` overrides
every profile (the test rigs use it).

## Signing in

`kiso login <provider>` stores a credential in `~/.kiso/auth.json` (mode
0600) — an API key for `anthropic` / `openai` / `deepseek` / `zai`, the
subscription OAuth sign-in for `chatgpt`:

```bash
kiso login chatgpt      # the subscription: a browser round trip, no key
kiso login deepseek     # a vendor key, typed once and stored
kiso login --endpoint https://gateway.example/v1   # a gateway's own key
kiso auth               # what is stored, masked
kiso logout deepseek    # remove it
```

**A stored credential never leaves the vendor's own origin.** Point a profile
at a gateway or any other custom endpoint and the vendor key you signed in
with is not forwarded there — that profile authenticates with a key stored
for the gateway itself, or with its own env var.

**A gateway has its own sign-in (0.40.6).** `kiso login --endpoint <url>`
stores an API key for that URL's ORIGIN — scheme, host and port; the path is
not part of it — under `endpoint:<origin>` in the same file. Every profile
whose `baseUrl` is on that origin uses it, before its `apiKeyEnv`, the same
order a vendor key takes; no other origin ever receives it — not another
port, not a subdomain, not a local forwarder in front of the gateway. So a
gateway profile starts from plain `kiso`, with no env var exported first.
A vendor's own origin is refused there (use `kiso login <provider>`).
`kiso logout --endpoint <url>` removes it; `kiso auth` lists it masked.

**A subscription sign-in's state is on its row (0.40.7).** An access token
past its expiry renews on the next use, so the profile stays available and
`/model` says `oauth, expired — renews on use`. When the token endpoint
REFUSES the renewal (the refresh token was revoked, e.g. by signing out of
all devices), kiso remembers it: the profile reads `(unavailable)` with the
reason `run kiso login chatgpt`, the refused token is not sent again, and
`kiso auth` marks the entry. A network failure is not a refusal and marks
nothing. A new `kiso login` replaces the entry and the mark with it.

**A stored credential OWNS its provider.** An unusable stored one is a loud
error, never a silent fall back to the environment variable — what you signed
in with is what runs. Without one the env layer still works: `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY` alone is enough (with both exported, OpenAI wins), and
`OPENAI_BASE_URL` retargets any compatible endpoint.

**Changed in 0.36.0.** That ownership now holds on the environment-selected
route too. Starting kiso with only `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in
the environment used to run on THAT key even when a credential was stored for
a recognised origin (`api.openai.com`, `api.deepseek.com`, `api.z.ai`); the
env key won by accident rather than by rule. The stored one wins there now.
`kiso logout <provider>` removes it and the env var takes over again, exactly
as the message has always said.
