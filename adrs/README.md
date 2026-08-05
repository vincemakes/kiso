# kiso ADRs — Architecture Decision Records

Every decision that outlives a commit is recorded here. The discipline:
**any conflict with a choice between options (裁决-style rulings) and any
supersession lands as an ADR IN THE SAME ROUND as the implementation** —
future stage specs cite this rule; a decision without an ADR is a commit
that has not finished speaking.

- 0001 — kiso is a microkernel, not a framework — **Superseded by 0021**
- 0002 — The event stream is the single truth — Accepted
- 0003 — The event sum type — Accepted
- 0004 — The terminal is first-class — Accepted
- 0005 — Retry stays in the loop — Accepted
- 0006–0019 — **never assigned** — the initial commit (c366b2c) numbered
  the protocol ADRs 0001–0005 and started the implementation series at
  0020; the gap is a numbering artifact, not lost records
- 0020 — Tool error classification — Accepted
- 0021 — The framework grows in packages — Accepted (supersedes 0001)
- 0022 — Reliable Session Alpha — the first vertical slice — Accepted
- 0023 — ajv is the core's single runtime dependency — Accepted
- 0024 — The execution ledger, exactly-once recovery, and real approval
  pauses — Accepted (superseded in part by 0025)
- 0025 — executionId identity, crash-safe storage, and real
  cross-process resume — Accepted (supersedes 0024 in part)
- 0026 — The byte-stable projection contract — Accepted
- 0027 — MicroCompact — context relief as a persisted decision —
  Accepted (decision #1 superseded in part by 自举 #3, 2026-08-04)
- 0028 — The extension contract — narrow surfaces, monotone by
  construction — Accepted (ask routing superseded by 0029)
- 0029 — An ask is answered by a human — no automated policy speaks for
  the human — Accepted (supersedes 0028's ask routing)
- 0030 — Official extensions — in-repo workspaces, kernel zero-diff —
  Accepted
- 0031 — Credential boundaries — strip by default, pass explicitly under
  human approval — Accepted
- 0032 — Subagents are durable sessions — Accepted
- 0033 — Skills load progressively through existing surfaces — Accepted
- 0034 — npm identity — a personal scope, the pi pattern — Accepted
- 0035 — The upgrade contract is quarantine, not seamless rolling —
  Accepted
- 0036 — The single-writer lock is a kernel flock held by a helper
  process — Accepted
- 0037 — Project-level capability is trusted by content digest, not by
  directory — Accepted
- 0038 — Uncertainty belongs to the crash window alone; the approval
  chain guards retries — Accepted (supersedes 0024 in part)

Old ADRs are kept verbatim — decision history is the point of the
discipline; superseded records carry the marker in their own Status line,
never an edit.
