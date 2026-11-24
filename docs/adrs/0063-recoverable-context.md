# ADR-0063: Recoverable Context — a lossy working context over lossless evidence, with durable decisions and on-demand recall

- **Status:** Proposed (drafted 2026-11-24). Docs only; nothing here is built. The
  owner approved the design direction and the stream's schedule on 2026-11-24;
  acceptance of this record, and every core line it implies, are separate owner
  decisions (§ 13).
- **Baseline:** `origin/main` 11e71495. Every code fact below was checked there.
- **Lineage:** the compaction-and-memory evaluation of 2026-11-03, the P0 offline
  harness and its reports (2026-11-08), the owner's design conversation of
  2026-11-09..23, and five forwarded reviews. The full design text, with its
  revision history, is kiso-doc `design-recoverable-context-memory-2026-11-23.md`
  (rev 5, sealed by the owner 2026-11-23). This ADR records the decisions; it does
  not restate the design's argument.
- **Layer:** core (two opaque log events and their projection, § 8), runtime
  (effective history, retrieval, extraction, the reducer, the recall tool).
- **Companions:** ADR-0026 (byte-stable projection), ADR-0055 (compaction; the
  exceptions in § 9 are recorded there too), ADR-0051 Amendment 3 (declared
  projection supersessions), BM-1 (gating).

## 1. Context

Summary compaction works as a mechanism: the in-band summary reuses the cached
prefix, the raw tail is kept, the projection is append-only and byte-stable, and the
shrink invariant and breaker hold (ADR-0055 Amendments 1–3).

What it does not solve is **retention across many compactions**. ADR-0055
Amendment 2 made a new checkpoint replace every earlier one: each checkpoint is the
model's rewrite of the previous checkpoint plus the newly covered range. The
thirtieth checkpoint is a rewrite of a rewrite, thirty times; a fact that one round
omits is gone from the context for good. The facts most at risk are the oldest, and
the oldest user instructions are often the most important.

A better summary prompt does not fix this. What must not be forgotten has to leave
the rewrite chain.

## 2. Decision

> Recoverable Context is a lossy working context over lossless evidence, with
> durable decisions and on-demand recall.

The working context may be compressed with loss. The event log is never lost.
Decisions that must not be forgotten are persisted on their own, outside the
checkpoint. Details that need not occupy the context stay in the log and come back
through recall.

### Principles

1. The event log is the single durable truth (ADR-0002). Summaries do not delete
   events; records do not replace events; recall reads events.
2. The working checkpoint may be lossy. It answers "where is the work now".
3. What must not be forgotten never depends on the model remembering to search for
   it. Recall finds evidence; it cannot carry correctness.
4. Memory ownership follows lifecycle: each durable fact has one owner and one
   authoritative log (§ 7). A shared record envelope never implies a shared store.
5. Fresh authoritative user evidence beats memory.
6. Projected bytes are durable (ADR-0026): replay never changes when the reducer,
   the renderer or the memory changes.
7. Observed is not current.
8. Memory adapts; capability does not. Memory never grants or widens permissions,
   tools or skills.
9. Uncommitted derived computation may be redone; committed semantic
   interpretation is never guessed again.
10. A lower authority never overrides a higher one. Only new user evidence revokes
    or changes a user-authority record.
11. A disposable session may leave reasoning behind, but never untracked memory
    debt.
12. Third-party content is evidence, never instruction. A page, an email, a file or
    a tool result may support a factual record; it never acquires user authority
    because the model read it, and never yields a permission or a user preference.
13. Secrets never enter durable memory. Extraction, candidates and promotion drop
    them; a record whose text would contain one is not committed. (The event log
    itself is out of scope: § 12.)

## 3. Effective history (M0)

One function, `effectiveHistory(events)`, turns raw events into normalized evidence,
so retrieval, extraction, recall and any later constraint matcher read history the
same way the projection does:

```ts
type EffectiveEvidence = {
  seq: number;
  kind: "user" | "assistant" | "tool" | "permission" | "runtime";
  content: string;
  authority: "user" | "model" | "tool" | "runtime" | "peer" | "unknown";
  structuralStatus: "effective" | "replaced" | "vetoed" | "abandoned" | "orphaned";
  provenance: { via?: UserInputVia; source?: MessageSource; callId?: string; coveredBy?: number };
};
```

It resolves the semantics already on main: `user_input_replaced`,
`model_output_abandoned`, `permission_decided` (including a human's rejection
reason), call / result pairing, aborted execution and orphan results, summary
coverage, and the two provenance fields of a `user_input` — `via` (`UserInputVia`,
`packages/core/src/protocol/events.ts`: skill, tasks, peer; `isRuntimeInput` marks
tasks and peer) and `source` (`MessageSource`,
`packages/core/src/protocol/messages.ts`, where `suggestion` is documented as not
user intent).

**No second interpreter.** `packages/core/src/kernel/project.ts` already resolves
these semantics for the projection. M0 extracts a shared function from that logic
rather than writing a parallel one, or the projection and recall will disagree about
the same history. The core size gate stays hard: if the extraction exceeds it,
existing semantics move out of core; the gate is not raised.

**The human-authoritative surface.** One helper, `humanAuthoritativeSurface(event)`,
is the only place that decides which text carries user authority:

| Input | Surface |
|---|---|
| plain user input, `source` absent or `user` | the effective content |
| replaced input | the final replacement only |
| skill (`via.kind = "skill"`) | `via.line`, the literal invocation; never the expanded body |
| tasks (`via.kind = "tasks"`) | none (runtime authority) |
| peer (`via.kind = "peer"`) | none (peer authority) |
| `source = "suggestion"` | none (a recycled chip, not intent) |
| `permission_decided` with a human reason | the reason text |

## 4. Retrieval and recall

- **M0.5 — internal retrieval, no model tool.** A runtime function over effective
  history: literal terms, paths, symbols, tool names, user and assistant text. It
  serves record debugging, the evaluation and later the constraint matcher, and does
  not touch the tool table.
- **M1 — the public `recall` tool**, last in V1:
  `recall({ query?: string; seq?: number; mode?: "effective" | "audit" })`.
  No embeddings, vector store or background index in V1; if it gets slow, a derived
  lexical index (deletable, rebuildable, never truth) is added. Every hit returns
  `seq`, kind, authority and structural status. **Registered at session start and
  fixed for the session's life**: a tool that appeared after the first compaction
  would change the tool-table bytes and break the cache prefix. It is a BM-1 § 3
  tool-schema round.
- **No `#seq` in cleared or covered placeholders.** Adding it would change existing
  sessions' projections through `project.ts`. Deferred indefinitely.

## 5. Records (M2)

The coding runtime's vocabulary is four kinds: `constraint`, `decision`,
`rejection`, `correction`. Not `fact`, `todo`, `hypothesis`, `preference` or
`observation` in V1. Every owner shares one envelope and stores its own records:

```ts
type RecordEnvelope = {
  id: string;
  kind: string;                          // the owner's vocabulary; opaque to core
  text: string;
  authority: "user" | "external" | "model" | "tool";
  quote?: { seq: number; span: string }; // required when authority = "user" (§ 5.2)
  evidence: Array<{ owner: string; seq: number }>;
  scope?: { paths?: string[]; symbols?: string[]; subsystem?: string };
  freshness: "durable" | "historical-observation" | "needs-revalidation";
  observedAt?: number;
  verifiedAt?: number;
  validFrom?: number;
  validUntil?: number;
  supersedes?: string[];
  derivedFrom?: string[];
};
```

- **Append-only.** A correction never edits a record; `r47 supersedes r18` is a new
  record, and a deterministic reducer derives the active set.
- **`external`** is authority from a named outside system the agent read (a CI
  status, a calendar event, a repository's state). `tool` says how something was
  read; `external` says who asserted it. Verification is not an authority; it stays
  in `verifiedAt` and the evidence.
- **Temporal validity.** `validFrom` / `validUntil` say when a fact held, apart from
  when it was observed. A superseded fact keeps its history with `validUntil` set;
  it is never deleted or flipped. No graph store is implied.
- **Freshness from day one.** "The user forbade Redis for session state" is
  `durable`; "CI was green at 14:02" is a `historical-observation` and is never
  presented as current.

### 5.1 Authority-aware supersession (reducer invariant)

The reducer accepts `source supersedes target` only when `validSupersession` holds:

| source \ target | user | external | model | tool |
|---|---|---|---|---|
| user | yes | yes | yes | yes |
| external | **no** | yes | yes | yes |
| model | **no** | **no** | yes | per kind |
| tool | **no** | **no** | yes | per kind |

For the normative kinds (constraint, rejection, correction), a user-authority record
changes only through a newer user-authority record whose quote passed the
provenance check. An invalid `supersedes` is ignored and reported; the source record
still commits at its own authority. Without this, a fabricated "the user now allows
Redis" that fails the check and is downgraded to `model` would still knock out the
real constraint.

### 5.2 The provenance check (hard condition)

**Every record with `authority: "user"`, of any kind, traces mechanically to
human-authoritative evidence.** The extractor outputs an evidence seq and a
candidate quote; the runtime takes `humanAuthoritativeSurface` of that seq; it
locates the candidate with a light canonical match (whitespace runs and full-width /
half-width forms only — no punctuation folding, since code, `!`, `-` and paths
change meaning); it stores the **exact source bytes** of the located span, never the
model's rendering. A record that fails is committed as `model` or dropped, never as
a user rule. This is the failure class that retired the drop arm in E6 (fabricated
acceptance criteria).

### 5.3 Extraction, cursors and batches

- **A separate call, never merged into the summary.** `summarized` commits first;
  extraction runs after; a summary never depends on it. Summary succeeded and
  extraction failed is a successful compaction.
- **The serializer** gives user input its complete human-authoritative surface and
  human permission reasons in full; assistant final text bounded; tool calls by name,
  path and arguments; tool results aggressively bounded but present; thinking,
  abandoned output and orphan results omitted. The extractor sees the active records,
  so it can write `supersedes`.
- **One cursor per owner**, independent of summary coverage. The session log keeps
  `sessionRecordCoverage`; each boundary computes its own target (context retire:
  the new `coversToSeq`; session retire: the latest settled seq; resume catch-up: the
  latest eligible seq). A 40K session that never compacts still has a target.
- **Batch identity**: `sessionId + coversFromSeq + coversToSeq + checkpoint identity`.
  A committed batch is never re-extracted, even after a restart; an extraction whose
  append never landed may be recomputed.
- **Empty is a result.** A range with no records commits `records: []`. A missing
  batch and an empty batch are different facts.

### 5.4 Extraction boundaries

Context retire (`summarized` committed) and session retire (close, handoff, reset,
lease release). Session retire is unreliable (a killed process), so unpaid debt is
settled at the next boundary or at resume, never by relying on a close event. **No
mid-epoch catch-up**: a failed extraction inside a live session is not retried on a
later round, which would change its prefix. A persistent-actor runtime adds a third
boundary, the work boundary, which consolidates session records upward and never
rescans raw evidence; it is designed separately and is not part of this ADR.

### 5.5 Candidates are not records

`evidence → candidate → consolidation / validation → durable record`. A candidate is
disposable: droppable, recomputable, not truth, never in the context on its own. A
strong signal ("remember this", an explicit correction or long-term rule whose quote
passes § 5.2) skips the queue. Candidates live in a derived store beside the owner's
log, never in the record ledger. No per-turn memory model call.

## 6. The stable record projection (M3)

```text
System prompt
Project instructions (AGENTS.md / CLAUDE.md)
──────────
Working checkpoint
Stable record projection (rendered bytes)
──────────
Recent raw tail
──────────
Current user input
```

- **The latest committed projection stays active until another committed projection
  supersedes it.** A new summary does not invalidate it: if extraction fails at
  compaction N, the model sees summary N + projection P(N−1) + tail, never an empty
  block. A rate limit must not make a constraint from dozens of rounds ago vanish.
- The block changes only at a legal boundary, never because the model read a file.
- Its bytes persist in the batch event; replay of an old session shows the old bytes
  after any reducer or renderer change.
- Placement before or after the checkpoint is fixed by the evaluation (§ 10).
- **Priority**, stated in the projection: fresh authoritative user evidence (the
  tail) > newer durable records > older durable records > working checkpoint >
  project memory > model inference. Mechanical enforcement is a later stage (M5).

**Progressive disclosure.** A store's size is never the context's size. Memory
reaches the model in layers: L0, a small manifest; L1, relevant active records — both
in projection bytes, changed only at boundaries; L2, topic or episode detail, and L3,
raw evidence through recall — both as tail evidence, never rewriting the prefix.

## 7. Ownership

| Owner | Authoritative store | Cursor |
|---|---|---|
| session | the session log: transcript, evidence, checkpoints, session records, bootstrap bytes | `sessionRecordCoverage` |
| project (V1.1) | `~/.kiso/projects/<key>/memory/`: a `MEMORY.md` index plus topic files | `projectRevision` |

- No global memory file. Cursors are never shared across owners.
- **AGENTS.md is normative; project memory is descriptive.** Project memory accepts
  only explicit or confirmed promotion ("remember this", a `/memory` command, a
  confirmed long-term ruling); anything else, however confident, is at most a
  promotion candidate. Promotion keeps `derivedFrom` and evidence.
- Work state is not memory, and a commitment is not a memory kind.
- The envelope is designed so that other owners (a work log, an actor's store, an
  application's own vocabulary) can reuse it without a schema change; every
  vocabulary is bound by § 5.1, § 5.2 and the promotion rule. Those owners are out
  of this ADR.

## 8. Core boundary

Core gains thin, **opaque** events in the session log, each carrying exact projection
bytes:

```ts
context_records {        // session-owned records only
  batchKey, coversFromSeq, coversToSeq, checkpointRef?, summaryDigest?,
  records: [...],        // opaque to core
  projection: "..."      // the exact bytes the model sees
}

context_bootstrap {      // a session's starting snapshot; absent in plain sessions
  sourceRevisions: {...},// opaque to core
  projection: "..."
}
```

Whether these are two event types or one opaque family is decided on the core diff;
the size gate favours one. Core validates, persists, replays and renders committed
bytes; it does not know what a constraint is. `summaryDigest` is lineage only, never
a condition for showing the projection. No sidecar store. A plain interactive session
that reads only AGENTS.md needs no bootstrap event until project memory exists.
**Every core line needs the owner's decision on the diff.**

## 9. Exceptions to ADR-0055

Recorded here and, in the same round as acceptance, in ADR-0055's own text:

- **To Amendment 2** ("the projection renders exactly ONE summary … plus the raw tail
  after it"): the projection also renders the latest committed record projection,
  which persists across compactions. The checkpoint still replaces every earlier
  checkpoint; records are not checkpoints.
- **To Amendment 3** (every checkpoint section is model prose): the record projection
  and verbatim quoted spans are program-filled. They are not checkpoint sections;
  the checkpoint's own sections stay the host's and stay prose.

Both are declared projection supersessions under ADR-0051 Amendment 3 (b) when M3
lands: red test first, moved goldens in the same change.

## 10. Evaluation

- Functional acceptance ("recall still returns round-1 evidence after 30
  compactions") proves recall works, not that the model remembers. A **retention
  evaluation** is also required: synthetic long sessions at kiso's real trigger
  points with dozens of compactions; planted facts (constraint, revoked constraint,
  rejected approach, number, file change, error and fix, lure, never mentioned);
  mechanically scored probes after the 10th, 20th and 30th compaction.

  | Arm | Content | Runs |
  |---|---|---|
  | A | current summary only | E1, after M0.5 |
  | V | summary + program-copied verbatim user surfaces and file operations | E1, after M0.5 |
  | R | summary + session records | E2, after M2 |
  | R+ | summary + records + recall | E2 |

- **A and V run before M2 is built.** They decide whether coding sessions pay for an
  extraction call and on which boundaries; they do not decide whether the envelope
  exists, which ownership, supersession, freshness and the constraint matcher need
  structurally.
- **No trigger ablation** (owner, 2026-11-23): memory is measured at the configured
  trigger.
- The owner's own sessions are a fixture source, not the population (2026-11-09).
- Criteria are frozen in a ready-kit before any paid run. E1 is pinned to a named
  main commit and its prompt bytes; a prompt change during the run voids it. Each leg
  reports its shape and spend before it runs.
- Offline evaluation proves size, retention ceilings and projection correctness.
  Cache hit, success rate and VTS need online paired rounds; no VTS claim is made
  offline.

## 11. Stages and gating

| Stage | Content | Done when |
|---|---|---|
| M0 | effective history shared with `project.ts` + `humanAuthoritativeSurface` | replaced / vetoed / abandoned / orphan / via / suggestion handled on fixtures and real logs; projection bytes unchanged |
| M0.5 | internal retrieval | query and seq lookups correct over effective history |
| E1 | harness at real triggers; arms A, V | criteria frozen before spend; results reported |
| M2 | session records: extraction, provenance check, cursors, batch identity, empty batches | append-only, supersede, crash catch-up exact, committed batches never re-extracted |
| E2 | arms R, R+ | reported against A / V |
| M3 | stable record projection | early rulings reach the context without recall; survives a failed extraction; bytes stable on replay |
| M1 | public `recall`, registered at session start | discovery experiment, then the paired bench and the reference column |
| T1 | raw tail default `min(0.1W, 100K)` → 20K | after M3 + M1 (§ 11.1) |
| V1.1 | project memory | a new session inherits confirmed project knowledge |
| M5 | constraint-aware execution | observer data first; blocking only for a high-confidence active user constraint |

V1 is complete at M3 + M1.

- **M0 and M0.5 change no request bytes**; the request-byte gates prove it.
- **M2 extracts and stores records but does not project them** until the prompt
  baseline frozen by the concurrent prompt rounds is in place. M3 is the first stage
  that changes what the model sees: a BM-1 § 3 context round, where the request-byte
  gates and the paired bench block.
- **M1** is a tool-schema round.
- The record and bootstrap events are kernel changes: an owner decision each, inside
  the core size gate.
- One planned stream under WIP ≤ 3.

### 11.1 The tail (owner ruling, 2026-11-23)

The raw tail stays `min(0.1W, 100K)` — made configurable by the trigger amendment —
until M3 and M1 have shipped; then the default moves to 20K, cut at whole message /
run boundaries. A short tail is safe only once checkpoint, records and recall carry
continuity. This reverses ADR-0055 Amendment 1 A5 ("the raw tail — UNCHANGED") when
T1 lands, by the owner. T1 runs the request-byte gates and the retention evaluation
at the new tail; it is not a tail ablation.

## 12. What this ADR does not decide

- **When compaction fires.** The trigger change (one trigger, `auto | percent |
  reserve`, the effective boundary the earlier of the user's setting and a derived
  safety boundary) is ADR-0055 Amendment 4, a separate record, implemented after the
  prompt baseline is frozen.
- **Microcompact** stays an EXPERIMENTAL primitive (ADR-0055 Amendment 1 A4); no
  automatic "cache cold → microcompact" policy. Recall is needed without it.
- **Evidence retention and secret redaction in the event log.** Principle 13 keeps
  secrets out of memory; the log still holds what it holds. A separate evidence and
  security design is required before any consumer handles credentials, payment data
  or private messages at scale.
- **Work, actor and application memory owners**, the work boundary, and a
  persistent-actor runtime: separate designs that reuse § 5's envelope.
- **Later derived layers** — episode summaries, skill candidates (validated and
  approved, never self-installed), entity subjects. Each is deletable and
  rebuildable, never a second truth store.
- Graph or vector databases, a per-turn memory call, a global store, mutable records,
  automatic skill installation: not planned.

## 13. Prior rulings this touches

| Ruling | Relation |
|---|---|
| ADR-0002 the event stream is the single truth | the foundation |
| ADR-0026 byte-stable projection | kept; record and bootstrap events persist bytes |
| ADR-0055 Amendment 1 A4 (microcompact a primitive) | kept |
| ADR-0055 Amendment 1 A5 (tail unchanged) | reversed at T1, by the owner (§ 11.1) |
| ADR-0055 Amendment 2 (one checkpoint) | exception (§ 9) |
| ADR-0055 Amendment 3 (sections are model prose) | exception (§ 9) |
| E6 (drop retired: fabricated criteria) | the reason for § 5.2 |
| 2026-09-23 owner decision (no search now; no cache-breaking microcompact) | search superseded: internal retrieval first, the public tool last; microcompact kept |
| 2026-11-09 owner: the owner's sessions are not the population | § 10 |
| 2026-11-23 owner: no trigger ablation | § 10 |
| BM-1 § 3 causal-relevance gating | § 11 |

Acceptance of this ADR is the owner's; the items above that it supersedes are named
so that the acceptance names them too.

## 14. When to overturn it

- If arm V matches R on retention at every depth, coding sessions drop the extraction
  call and keep program-copied surfaces; the envelope, ownership and supersession
  stay for the owners that need them structurally.
- If the provenance check rejects most genuine user rules in real logs, the canonical
  match is widened by evidence (named forms), never to punctuation folding.
- If the stable projection measurably costs success rate or VTS in the paired bench
  at M3, its placement or budget changes; durable decisions do not move back into
  the checkpoint chain.
