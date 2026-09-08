# @vincemakes/kiso-provider-openai-responses

The OpenAI **Responses** adapter — one adapter, two targets, no SDK and no
new dependency (plain `fetch` plus a hand-rolled SSE reader).

| target | auth | endpoint | what is different |
|---|---|---|---|
| OpenAI first-party | API key (`kiso login openai`, or `OPENAI_API_KEY`) | `https://api.openai.com/v1/responses` | the public Responses API |
| ChatGPT subscription | the stored OAuth credential (`kiso login chatgpt`) | `https://chatgpt.com/backend-api/codex/responses` | `chatgpt-account-id` / `originator` / `OpenAI-Beta` headers; `store: false`, `include: ["reasoning.encrypted_content"]`, `prompt_cache_key` |

The target is inferred from the options the factory is handed — an
`apiKey` builds the first-party adapter, an `oauth` thunk builds the
ChatGPT one — so there is no second switch that could disagree with the
credential. The thunk is awaited **once per request**, which is what lets
the credential store refresh a token that expires mid-session.

Requires Node >= 22. See the repository README for the framework overview.

## Support level

Filled from this package's own gates. Every one of them runs against a
LOCAL double (`tests/helpers/rig.ts`); no test reaches a vendor.

| capability | first-party | ChatGPT | evidence |
|---|---|---|---|
| auth header | ✓ | ✓ | `or1-request-rig` — the frozen request bytes per target, and the ChatGPT-only headers absent on the first-party one |
| streaming | ✓ | ✓ | `or1-stream` — the nine adapter events in order, `usage` before `stop`, both from the same terminal frame |
| tool call + next turn | ✓ | ✓ | `or1-tool-turn` — the emitted `callId` is the `call_id`, and the next request replays it as `function_call_output` |
| reasoning effort | ✓ | ✓ | `or1-request-rig` shape 3 — `reasoning.effort` carries the level it was handed |
| reasoning replay (`store: false`) | n/a | ✓ | `or1-continuation` — one `stop.continuation` entry per encrypted reasoning item, replayed on scope match only |
| cancel | ✓ | ✓ | `or1-errors` — an abort ends the turn with an `AbortError`, no `stop`, nothing retryable |
| error mapping | ✓ | ✓ | `or1-errors` — 429/401/400/503 by status, both `Retry-After` forms in milliseconds |
| retry authority | ✓ | ✓ | `or1-retry-authority` — exactly one request per stream, on every failure class |
| **a real vendor leg** | **unrun** | **unrun** | needs a key / a subscription sign-in and an owner-budgeted run |

`unrun` means exactly that: the behaviour is proven against the recorded
dialect, and nobody has yet pointed this adapter at the vendor.

## What it deliberately does not send

`text.verbosity`, `tool_choice`, `parallel_tool_calls`, `service_tier`,
zstd request compression, and the WebSocket transport. Each is a real
field on the wire; none of them has a kiso setting behind it, and a
hardcoded default would be this adapter inventing a policy nobody chose.

`strict` is likewise absent from tool definitions: kiso's schemas are
already closed worlds validated by the kernel, and the flag would add a
second validator with different rules.

## Two behaviours worth knowing

- **`max_output_tokens` below 16 is refused, not clamped.** The provider
  rejects it; kiso answers before the request rather than silently
  raising a bound the caller asked for.
- **`usage.inputTokens` is the provider's RAW count**, which on this
  dialect includes the cached prefix. The runtime's canonicalizer owns
  the subtraction — doing it here too would bill the cached tokens away
  twice.
