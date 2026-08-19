# ADR-0052: Durable Turn Commit — the boundary between model-intent validity and real-world effect

- **Status:** Accepted — the EC-1 effect classification round (0.13.0).
  The spec was SETTLED by the owner on 2026-08-18 with design proposal v2
  normative (its load-bearing premise code-verified before adoption); the
  ⓪ probe and the four in-round checkpoint rulings (a)–(d) were
  adjudicated by the integrator and are recorded in §10.
- **Date:** 2026-08-19
- **Layer:** L2 Kernel (stop handling, the scheduler) / L3 Tool (the
  contract field) / runtime (recovery derivation, the truncation guard)
- **Scope:** the durable boundary itself. The scheduler's own record
  stays in ADR-0024, amended in the same round (**Amendment 3**); the
  recovery law stays in ADR-0047; the frozen event contract (ADR-0051) is
  UNCHANGED by this round — no new event variant, no new field, no
  envelope change.

## Context

Before EC-1 the kernel had three durable boundaries and no way to say
which of them meant the model's turn was VALID. `run.ts:167` persisted
every event as it yielded, so a `stop` became durable the moment the
adapter emitted it — before the stream had proven clean. Meanwhile
`recovery-plan.ts:159` keyed the committed boundary on that same durable
stop. Two truths, one event: the live loop could still void a turn whose
stop was already on disk, and a resume reading that disk would call the
turn committed.

The gap was not theoretical. ADR-0024 Amendment 1 launched a tool
handler the instant a `tool_call_end` passed validation and the policy
chain, so an invalid turn's destructive edit had already run by the time
the violation was detected — Amendment 1 decision #5 says so plainly
("the calls were already launched"). And ADR-0024 Amendment 2, retiring
the unwired `concurrencySafe`, left the same-path write race open with an
instruction: the mechanism that closes it must not be built on a per-tool
opt-in for CORRECTNESS.

EC-1 builds the missing boundary and closes the race behind it.

## Decision

### §1 The chain — three durable boundaries, three honest states

```text
untrusted model stream
        ↓  clean exhaustion
DURABLE TURN COMMIT          ← new in EC-1
        ↓
authorized invocation        ← human asks move AFTER commit
        ↓
DURABLE STARTED              ← exists today (write-ahead intent)
        ↓
real-world effect
        ↓
DURABLE RECEIPT              ← exists today
```

After any crash, at any byte, the log answers with one of three honest
states: **no durable stop → UNCOMMITTED · durable stop → COMMITTED ·
durable STARTED → the effect MAY have happened.**

### §2 The seven invariants (spec-normative, verbatim)

```text
1. DURABLE COMMIT      a compatible stop is persisted only after
                       clean stream exhaustion
2. NO EFFECT BEFORE INTENT   STARTED is durable before every handler
3. COMMIT GATING       a commit-required handler never starts before
                       durable Turn Commit
4. SAFE SPECULATION    only universally precommit-safe, ALREADY-
                       AUTHORIZED calls may start before Turn Commit
5. FIFO EXCLUSIVE BARRIER    an exclusive invocation blocks all later
                       siblings from overtaking it
6. EXECUTION CAPACITY  waiting (for commit, approval, or a barrier)
                       consumes no execution slot
7. INVALID TURN HONESTY      precommit executions may be durable
                       facts, but they never make an uncommitted
                       model turn valid
```

### §3 Turn Commit — the definition

> A turn is COMMITTED when the adapter stream has cleanly exhausted with
> exactly one structurally compatible stop and no later violation.
> Receiving a stop event is NOT commit.

Mechanically: the stop is HELD in memory when the adapter emits it —
neither appended nor yielded, because yield order must equal append order
— and the kernel keeps draining. A second stop, an event after the stop,
a forged event, or an incompatible stop reason VOIDS the turn and the
stop never lands. Iterator done plus structural compatibility → the
append and the yield happen together, in the loop's ordinary order. What
the boundary buys, stated as the equivalence the kernel now keeps:

> a durable compatible stop ⇔ this producer observed clean stream
> exhaustion.

Nothing about the event contract moves. The stop is the same event with
the same fields; only its persist MOMENT changed.

### §4 What moved, stated honestly

The proposal's "byte-identical durable sequence" was TOO STRONG, and the
round says so rather than quietly shipping the weaker claim. A
commit-required call's `tool_execution_started` / `succeeded` / `result`
now land AFTER the stop instead of before it: one transposition per turn.
Three claims survive, each asserted against a real 0.12.0 log replayed
through the current kernel (`packages/runtime/tests/ec1-bytes-proof.test.ts`):

1. **The durable event MULTISET is unchanged.** Same facts, same events,
   same count — a permutation, never an addition or a loss.
2. **`projectMessages` is BYTE-IDENTICAL**, on both arms (a certified
   tool and an undeclared one). The permutation never reaches the model:
   ADR-0024 Amendment 1 decision #6 already buffered a turn's tool
   results and emitted them in CALL order at the turn boundary, so
   physical order was never in the projection.
3. **The primary request surface is byte-identical** — not re-asserted in
   the bytes proof, deliberately. The rent-ledger gate already pins that a
   real session's recorded ledger equals `scripts/request-surface.mjs`'s
   prediction surface by surface, EC-1 moved no byte of either side, and
   that gate unchanged and green is the stronger statement. (R3v2-F1 moves
   the sideQuery surface and ships as its own patch, outside EC-1's causal
   fence — which is why this claim stays clean.)

The order claim is worth stating precisely, because the honest version is
better than the one it replaces. **Before EC-1 the durable order was a
RACE** between the streaming launch and the rest of the stream — nobody
could promise it. Measured both ways on the recorded run's spacing: a
CERTIFIED call reproduces the published bin's sequence byte for byte (the
certificate buys back the ORDER, not only the throughput), while the same
script with the certificate removed always puts the stop first. EC-1
turns a race into an invariant.

**The duplicate-stop shape change is a deliberate improvement, not a
side effect.** Before EC-1 a duplicate stop left TWO stops on disk (the
first had already been persisted) plus the void; now neither lands. The
produced shape is strictly more honest — a durable stop always means a
clean exhaustion. Readers accept BOTH shapes: old logs carrying the
pre-EC-1 pair still load, validate, project and derive, which the ⓪
generation-compat probe checked and the generation gate holds
permanently. This is a change to what kiso WRITES, never to what it
READS; ADR-0051 §5's admission rules are untouched because no variant and
no field changed.

### §5 The `effects` field — an optimization certificate, never a safety claim

```ts
readonly effects?: {
  readonly precommitSafe?: true;
  readonly concurrency?: "shared";
};
```

There is no `"exclusive"` value and no `false`, **by design**. ABSENCE is
the conservative truth — an undeclared tool is commit-required and
exclusive — so the type system cannot express the claim that something
unsafe is safe. **Correctness never comes from a declaration**; a
declaration only buys performance back. A tool author who forgets
everything gets the safe schedule, and the most a forgotten certificate
can cost is throughput.

- `precommitSafe` — "running this before the turn commits is harmless:
  read-only AND free AND local, for EVERY invocation."
- `concurrency: "shared"` — "EVERY invocation may overlap every sibling."

This is the answer ADR-0024 Amendment 2 demanded and the shape it argued
for: Amendment 2 observed that parallel-safety is a per-CALL judgment a
static per-tool flag cannot express, and concluded a future mechanism
must arrive "with a wiring and a gate". EC-1's resolution is to make the
per-tool field incapable of expressing a safety claim at all, and to
enforce both certificates in the round that introduces them — the SC-1
lesson, paid once.

Built-ins: `read_file`, `list_dir` and `search_text` declare both;
`write_file`, `edit_file` and `shell` declare NOTHING, which is what
closes the same-path write race without asking their authors to remember
anything. Third parties participate on equal terms — a plain `.mjs`
loaded from disk carries its declaration verbatim through the extension
loader (`ec1-extension-effects.test.ts`), pinned because a contract only
kiso's own tools may enter is not a contract.

### §6 The FIFO fence, and the authorization order

Both belong to the scheduler and are recorded in full in **ADR-0024
Amendment 3**. In brief, because the invariants above depend on them:

- **The fence is installed at ACCEPTANCE** (in call order), not when a
  handler starts — that is what makes it FIFO. A later sibling, including
  a precommit-safe read, never overtakes an exclusive invocation accepted
  before it, so a read can never observe a half-written file.
- **The authorization order:** for commit-required calls the human ask
  moves AFTER Turn Commit — a person must never approve a call whose turn
  then proves invalid. **Precommit launch iff `precommitSafe` ∧
  authorization already satisfied** (an auto-allowed verdict). Both halves
  are load-bearing: the certificate says the EXECUTION is harmless, never
  that the authorization is unnecessary.
- **The window is an execution window**: waiting — for commit, for a
  human, or for the barrier — consumes no slot (invariant 6).

The claim EC-1 proves is stated at exactly its true strength: **an
invalid turn never starts a COMMIT-REQUIRED TOOL HANDLER.** Not "the
world stays unchanged" — decide, hooks and asks have their own observable
behavior; the handler boundary is what this round proves.

### §7 The live void — the loop is a SECOND PRODUCER of `model_output_abandoned`

Closing the destructive hole opened a smaller one, and the honest causal
story belongs in the record. Invariant 3 means a voided turn's
commit-required call never runs — so nothing answers the `tool_use` its
`tool_call_end` already persisted. The run ends on its error terminal,
and the recovery driver never sees it: the driver's first rule is "the
open run reached its terminal". The NEXT turn of the SAME LIVE session
would therefore send the provider an assistant `tool_use` with no
result — the EC1-F1 provider-400 class, reached without a crash. Pre-EC-1
the shape could not occur, because the streaming launch had already
answered the pair.

**A live void must leave a projectable log.** The fix is the instrument
the resume already uses, produced in the other place: the loop becomes a
SECOND PRODUCER of `model_output_abandoned` — an EXISTING variant, so no
new protocol surface and the frozen event contract holds. It voids the
draft range from the turn's own start (the previous stop, the user input,
or a microcompact boundary — `log.lastSeq` captured before the model
output), and is idempotent by construction: the marker becomes the last
boundary, so no later resume derives a second draft over the same range.

Scope, stated so it is not mistaken for more: the live producer covers
the DANGLING-PAIR class. A voided text-only turn still leaves its deltas
projecting until a resume's Gap B voids them — pre-existing behavior on
both sides of EC-1, unchanged here.

### §8 Recovery — execution facts vs turn facts

The spec sentence, verbatim:

> Precommit execution does not commit the invocation or the model turn.

Its receipt may be durable, but its model intent remains part of an
uncommitted draft until Turn Commit. The new prefix classes:

- **precommit STARTED + receipt + no stop** → the execution HAPPENED (a
  durable fact) AND the turn is an uncommitted draft (a turn fact). Both
  are true: the draft voids, the receipt stays honest history.
- **precommit STARTED, no receipt, no stop** → RESOLVE_UNCERTAIN FIRST —
  reality before turn validity — THEN abandon the uncommitted draft.
- **finding EC1-F1:** a bare tool-call suffix with no stop used to derive
  CONTINUE_MODEL and project an assistant `tool_use` with no result. The
  draft scan now counts `tool_call_end`, not text alone.

**The started-receipt refinement** is the rule that keeps the two fact
kinds apart, and it is deliberately the same rule in both producers. A
call makes a draft **only while it is still pure intent**. Once it has a
durable `tool_execution_started` it is a FACT the existing repair passes
own: voiding it would strand a real receipt behind a voided declaration
(pair atomicity would then drop its result, and the model would never
learn the outcome of work that actually happened). Pre-EC-1 logs contain
exactly that shape — a call that launched mid-stream and finished before
its stop was persisted — and they keep recovering the way they always
did. The live producer in §7 obeys the identical predicate, so a
precommit execution's receipt is never stranded by a marker the loop
writes.

**Generation compat, named as such.** `recovery-plan.ts`'s `liveAsk`
clause — a durable `permission_requested` with no stop before it — is now
UNPRODUCIBLE, because §6 moved asks after the commit. It is retained with
an era note, for pre-EC-1 logs alone; deleting it would silently change
how those sessions recover. It stays until the generation corpus no
longer contains a pre-EC-1 era. The corpus gained the two 0.12.0-era
samples that are that clause's evidence, produced from the real published
bin before 0.13.0 made such a producer impossible; the EC-1-era
counterpart is OWED post-publish and noted in `PROVENANCE.md` (R4a
forbids synthesizing one from an unreleased tree).

### §9 The truncation contract amendment

`max_tokens` semantics after EC-1, as the guard's contract: **a
commit-required call NEVER executes; a precommit-safe call MAY already
have executed and that execution is declared harmless; the turn is NOT
committed; precommit results never legitimize it** (invariant 7).

The kernel closed the destructive half itself — `max_tokens` cannot carry
a tool call, so a truncated turn never reaches Turn Commit. What the
flagship wrapper still buys is stated as plainly: REPORTING (the held
batch is released with `input: null`, so every call is answered with an
honest `invalid_input` result instead of being left resultless) and THE
PRECOMMIT CASE (the hold sits upstream of the kernel, so guarded, not
even a declared read runs). The conservatism split did not disappear; it
moved from "a destructive edit runs or not" to "a harmless read runs or
not, plus the reporting". The old zero-tools-on-truncation pins move
under the declared TRUNCATION class rather than being deleted, so a green
read-count can never be mistaken for a regression.

### §10 The E1 extraction, and the criterion

The scheduler needed room. core stood at 1974/2000; the extraction
question was NOT "who has zero external callers" but:

> if this module left core, could the kernel still define its own
> execution-correctness semantics?

EventLog, execution identity, projection and the effect scheduler answer
NO — they stay, whatever the size gate says. Delivery-truth governance
answers YES: it is an L7 eval concern, and `governance/delivery.ts` left
core for `kiso-evals`, where its only consumer always was. **core 1974 →
1935 paid for the scheduler; the 2,000 gate stands, unmoved.** Zero
behavior change (the m3 pins are unmoved).

core's public surface lost exactly three names, now exported from
`@vincemakes/kiso-evals`: **`DeliveryConfig`**, **`DeliveryVerdict`**,
**`analyzeDelivery`**. The runtime's pinned public surface is unchanged
at 40 names.

The four in-round checkpoint rulings, for the record: **(a)** the
incidents user-abort pin was tightened after a mechanism analysis showed
no abort re-check had weakened (a test fix, not a code fix — the refusal
now REACHES the consumer because §6 removed a microtask hop);
**(b)** the kill -9 parallel cell was rebuilt on a test-authored
extension tool declaring `concurrency: "shared"`, after the loader check
in §5 confirmed there was no product gap to work around; **(c)** the
three suites named for triage were measured, two needed nothing, and the
third's counting claims were restated around a cadence change that is
reported, not hidden; **(d)** an unreachable duplicate `case
"microcompacted"` was removed from `project.ts` — a JavaScript switch
runs the first matching case and esbuild had been emitting the warning on
every build.

## Consequences

- The kernel separates model-intent validity from real-world effect for
  the first time; every claim above is a property of the DURABLE LOG, so
  it survives the process.
- The crash matrix gains a boundary and a window that did not exist
  before: the stop is held while the stream drains, so a process can now
  die with a complete tool call on disk and NO stop after it. Pre-EC-1
  that window was microseconds wide; it is now the whole stream tail. Four
  new rows cover one waiting state each.
- Undeclared tools serialize. That is intentional and it has a cost: a
  read accepted after a write loses its latency win even when the two
  touch unrelated paths, and mixed/write workloads lose the old racy
  parallelism. A database that drops its locks also gets faster; the old
  speed has no right to be a baseline.
- Two declared test classes carry the round's restated pins:
  SCHEDULER-TIMING (every test that pinned launch timing) and TRUNCATION
  (the zero-tools-on-truncation family). Each member is restated, none
  relaxed; `truncation-guard.test.ts` is byte-unchanged and is the
  evidence that the amendment relaxed the contract's CLAIM without
  relaxing the guard.
- core has 3 lines of headroom (1997/2000). The ⓪ adjudication's
  second-extraction question is live for the next round.

## Gates

| what it holds | executable gate |
| --- | --- |
| ① durable commit, and the crash pair A/B as BYTES | `crash-matrix.test.ts` rows A/B — `prefixB.slice(0, prefixA.length)` equals `prefixA`, `prefixB.length === prefixA.length + 1`, and the extra event is the stop; the resumes diverge on that one event (A derives ABANDON_DRAFT and never executes, B derives DECIDE_PERMISSION and executes exactly once) |
| ③ commit gating · ④ safe speculation · the ask order | `ec1-scheduler.test.ts` — a post-stop violation and an incompatible stop each ask nothing and start nothing; a valid turn asks AFTER the durable stop; declared+auto-allowed starts BEFORE it; declared-but-asking and undeclared start after |
| ② the certificate, ENFORCED | `ec1-effects.test.ts` (same-path serialization in call order, declared-shared overlap, no overtaking) · `ec1-extension-effects.test.ts` (the declaration survives the disk loader; absence stays absence) |
| ⑤ FIFO barrier · ⑥ execution capacity | `ec1-effects.test.ts` (a shared call ahead of an exclusive one is not delayed) · `crash-matrix.test.ts` C1 (a held sibling leaves NO started receipt — clean, not uncertain) · C2 (crash between commit and an exclusive launch leaves no receipt at all) |
| ⑦ invalid-turn honesty | `ec1-scheduler.test.ts` (a precommit execution on a voided turn leaves a durable receipt AND no durable stop) · `sc1-truncation-contract-pins.test.ts` clause 2 |
| the permutation claims | `ec1-bytes-proof.test.ts` (multiset unchanged; `projectMessages` byte-identical on both arms; the order claim measured both ways) · the rent-ledger gate, unchanged, for the request surface |
| generation compat | the generation gate + `PROVENANCE.md`, with the two 0.12.0-era samples from the real published bin |
| the live void | `ec1-f1-bare-call-draft.test.ts` (no request ever carries a `tool_use` without its result; one durable marker; the derivation over the result is idempotent) |
| crash coverage | crash matrix 15/15 · `kill9.test.ts` 3/3, real PTY, real SIGKILL, three uncertain executions each answered |

## When to revisit

Each item below is an OVERTURN condition for a deliberately conservative
default. None of them may enter as a declaration; each enters with a
wiring and a gate, the ADR-0024 Amendment 2 standard.

- **`resourceKey` — per-call conflict granularity.** The fence is
  per-tool because a per-CALL safety claim is exactly the kind the type
  system could not police. Overturn it when a real workload shows two
  invocations of one exclusive tool provably touching disjoint resources
  and paying measurably for the fence — and only with a key the kernel
  computes or validates, never one a caller asserts.
- **Safe overtaking.** A precommit-safe read accepted after a write
  currently waits. Overturn it when there is a mechanism that can prove
  the read does not observe the write's path — the proof is the feature;
  the latency is the reward.
- **Snapshot semantics.** The strongest of the three and the furthest
  away: a read that sees a consistent pre-write view needs a storage
  story kiso does not have. Not before a real product hits it.
- **The window size** — unchanged at 4, and now measuring running work
  rather than pending invocations (ADR-0024 Amendment 3).
- **The `liveAsk` generation-compat clause** — delete it only when the
  generation corpus no longer contains a pre-EC-1 era.
