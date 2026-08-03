# ADR-0023: ajv is the core's single runtime dependency

- **Status:** Accepted
- **Date:** 2026-08-03
- **Layer:** L3 Tool

## Context

`Tool.parameters` was always declared to be a JSON Schema the kernel validates
before execution (tool.ts). Until Phase B of Reliable Session Alpha it was
only advertised, never enforced: a model emitting `{a: "not a number"}` sailed
straight into the handler. The kernel also claimed zero runtime dependencies —
a marketing line, not a decision, and Phase B (real validation) forced the
choice.

The alternatives were both worse:

- **Hand-rolling a draft-07 subset** — this is how schemas silently stop
  meaning what they say (the failure class behind pi's
  "validation-that-casts" bugs). Correct JSON Schema is a hard spec;
  a partial implementation is a correctness bug wearing a green checkmark.
- **Moving validation to the harness** — validation is a kernel contract
  (the kernel is the only thing that runs tools, ADR-0001). Leaving it out
  meant every harness re-implements the same schema engine and they
  disagree; the whole point of L3 is that tools mean the same thing
  everywhere.

## Decision

The core gains exactly one runtime dependency: `ajv` (draft-07, strict mode
off, compiled once per schema and cached). Argument validation happens in
`executeOne` before the permission negotiation and before the handler; a
failed validation is an `invalid_input` tool result — the handler never sees
garbage, and the model sees the reason.

The "core imports zero runtime dependencies" claim in ADR-0001's framing is
superseded for this one exception. Everything else remains dependency-free:
protocol, kernel, tools use only stdlib-free primitives.

## When to revisit

A second validation need appears (e.g. streaming partial-input validation)
and ajv's compile-once model no longer fits — then revisit; a cached
draft-07 subset is the fallback, pinned by the same fixtures.
