# TODO — standing deferred work

Registered across rounds; linked from the README. Rounds add here, and
resolved items move to the round record that delivered them.

## 1.0 prerequisites

- *(resolved in the 0.1.47 round — R-G, ADR-0050: the python3 flock
  helper is retired; the session store's single-writer lock is the
  native identity-confirmed link lock. The external review's risk #4,
  `docs/reviews/2026-08-06-external.md`, is closed.)*

## 1.0 round

- **Event union surface review** — the durable event schema is the
  framework's long-term maintenance surface: every historical event must
  keep replaying correctly forever. A full review of the union's
  forward-compat (field addition/removal, versioning, projection rules,
  extension-writeability) is a 1.0 round item. Adopted from the external
  review's risk #5.

## P2 (found in 0.1.25 release verification)

- **cache % can render >100% on the anthropic-compat path** — DeepSeek's
  anthropic-compat endpoint reports `input_tokens` EXCLUDING the cached
  prefix (fresh-only: observed inputTokens 59/111 vs cacheRead 1024),
  while its openai-compat endpoint reports input INCLUDING cache (the
  0.1.23-established convention). The recap/status formula
  `cache/in` (correct for the openai convention; real Anthropic's
  input_tokens also includes the cached portion) then renders nonsense
  like `cache 923%`. Fix direction: a per-provider input convention
  signal (or the extractor's fresh/total split) feeding the recap's
  ratio; register the reproduction: anthropic-compat short session +
  `grep cacheRead`.

## Standing (per-round)

- the todo extension (the interactive todo surface) — deferred each round per the
  spec; still deferred after TUI v5.
- the three-terminal on-device acceptance — the v4/v5 checklist tables in the round records; the
  human-terminal drag/screenshot items await the user's real terminals.
