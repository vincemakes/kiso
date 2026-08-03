# ADR-0021: The framework grows in packages; the core stays a kernel

- **Status:** Accepted (supersedes ADR-0001)
- **Date:** 2026-08-03
- **Layer:** Cross-cutting

## Context

ADR-0001 drew the line at the kernel: kiso owns L1/L2/L3/L7 and nothing else —
session persistence, UI, permission policy were "the harness's job", and "a
framework is the thing you eventually fight".

One product's experience (mauri) made that line look right; the direction
ruling of 2026-08-03 overturned it. A kernel-only package wins the "small" bet
and loses the "useful" bet: session, CLI, settings, and tooling are the parts
every harness re-implements by hand, and each re-implementation re-learns the
same failure modes (CC's transcript drift, pi's three-copies-of-defaults).
The alternative — a single monolithic core — is worse: pi's 3,126-line
agent-session hub is the source of five of pi's ten documented weaknesses.

## Decision

kiso is a framework in two layers:

1. **The core (`@kiso/core`) stays a kernel.** The 2,000-line cap, the ADR
   discipline, and the closed contract surface (event union, message union,
   adapter, tool, hooks) are unchanged. ADR-0001's decision stands for
   everything inside the core.
2. **The framework grows in packages, unbounded.** Session (append-only log +
   seq restore), CLI, settings, built-in tools, extensions — each its own
   package with its own identity. Packages communicate through the event
   stream and hooks. No package may become a central hub: a package that
   other packages must reach through (a second agent-session) gets split.

The two properties the kernel sells — replayable trajectories (ADR-0002) and
honest terminals (ADR-0004) — are the seam packages plug into: session is a
consumer of the stream, CLI is a consumer of the stream, settings feed hooks.

Roadmap follows: G1 session → G2 CLI → G3 settings + built-in tools →
G4 extensions + 0.1.0. Kernel stays at 1152/2000 lines; framework has no
line budget.

Superseded items from ADR-0001: "session persistence is the harness's job"
(now a package), "if you need more, fork it" (now: grow a package), and the
explicit refusal of "a framework is the thing you eventually fight" (a
framework without a central hub is the thing we build).

## When to revisit

A package grows past the point where it can stay small without reaching into
the core — pull the repeating shape down into core only when 2+ packages
express the same semantic (mauri §11 discipline), and only if the core stays
within 2,000 lines. Otherwise: split the package.
