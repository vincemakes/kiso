# ADR-0004: The terminal is a first-class event, not a return code

- **Status:** Accepted
- **Date:** 2026-08-02
- **Layer:** L2 Kernel

## Context

Claude Code's query() has eleven return points (completed, stop_hook_prevented,
prompt_too_long, blocking_limit, max_turns, aborted_tools, hook_stopped, ...)
and every consumer discards the return value — the REPL and the SDK both
`for await` without reading it, and the Terminal type is an `any` stub. An API
error returns `{reason: 'completed'}`. Consumers infer the outcome by sniffing
message shapes. A failed turn wears the reason of a successful one.

## Decision

Every run converges on exactly one `TerminalEvent` — its last event, in the
same stream as everything else, so it cannot be lost. `Terminal` is a closed
union (`completed` / `max_turns` / `error` / `aborted` / `hook_stopped`);
consumers `switch (outcome.kind)` and an unhandled case is a compile error.
The loop has no other exit: if it yields a terminal, it returns.

## When to revisit

A new terminal shape that cannot be expressed as one of the five. Add it to the
union and let the compiler find every consumer.
