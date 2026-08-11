# ADR-0020: Tool errors carry a kind, and the kernel never branches on it

- **Status:** Accepted
- **Date:** 2026-08-02
- **Layer:** L3 Tool

## Context

A tool failure that is reported only as `isError: true` collapses three
different truths: the tool refused to run (a gate was unmet), it ran and
produced nothing, or it blew up mid-flight. Harnesses that cannot tell them
apart cannot tell a blocked agent from an unproductive one — the exact
confusion behind "the agent said done but nothing landed".

## Decision

`ToolErrorKind = "invalid_input" | "precondition" | "transient" | "fatal"`,
carried on `ToolResultEvent.errorKind` when `isError` is true. The kernel
never branches on this value: it is a pass-through signal for the harness,
which owns retry and re-route policy for tools (model/transport retry is the
loop's job, ADR-0005 — two different layers, two different mechanisms).

`precondition` is the load-bearing case: it separates "refused" from "ran and
produced nothing".

## When to revisit

A consumer needs a fifth kind. Add it to the union and let the compiler find
every switch.
