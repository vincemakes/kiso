# ADR-0001: kiso is a microkernel, not a framework

- **Status:** Accepted
- **Date:** 2026-08-02
- **Layer:** Cross-cutting

## Context

Every agent framework hands you code and API docs; none hand you the reasoning.
The validated precedent is mauri (Python microkernel, three products in
production): L1-L3 (protocol/kernel/tool) converge across implementations,
L4-L6 (knowledge/surface/ops) belong to products. Claude Code's governance is
patched on; pi's is cut away entirely. kiso owns the contracts that genuinely
repeat and nothing else.

## Decision

kiso owns exactly: L1 protocol (events/messages/adapter), L2 kernel (loop/hooks/
modes/compaction), L3 tool (contract/registry/repair/concurrency), L7 eval
(faux provider + matrix). Everything else — session persistence, UI, billing,
skills content, permission policy — is the harness's job. A kernel that decides
those for you is a framework, and a framework is the thing you eventually fight.

The core never exceeds 2,000 lines. CI enforces it before install (see
`scripts/check-size.mjs`). If you need more, fork it.

## When to revisit

A second product proves a kernel-owned capability we refused (session tree,
permission store) genuinely repeats across harnesses. Until then it stays out.
