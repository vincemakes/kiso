# EX-0 — the failure catalog (when NOT to trust yourself)

The review's fourth output. The most valuable experience a system can
hold is not "what worked" — it is the standing knowledge of the
conditions under which its own conclusions are untrustworthy. These are
Bound Experiences too (each cites durable evidence), but they assert a
SELF-DISTRUST rule rather than a world fact. This catalog is the seed;
each entry is phrased so a future runtime could consult it as a guard.

## FC-001 — an uncertain execution must not become a confident claim

- **rule:** when an effect attempt has started and its receipt is
  missing (the uncertain-execution window), do NOT let a human-facing
  claim assert deployed/not-deployed — the honest value is `unknown`
  until externally resolved.
- **evidence:** RD1A-F1 / EP1-Finding-001 (c2-r2, c3-r1: STATUS said
  `no` while the ledger held an end row). Bound in EP1-Finding-001.
- **why it is a self-distrust rule:** the model's LOCAL reasoning was
  coherent ("I saw a denial, so it never ran") and still wrong. The
  lesson is not "reason better" — it is "on THIS boundary, do not trust
  a local narrative over the durable ledger".
- **scope:** effectful operations crossing a crash/resume boundary.

## FC-002 — a known-applied effect must not be re-issued on resume

- **rule:** when the uncertain-execution ledger shows an effect
  already applied, resume must treat it as done, not re-run it.
- **evidence:** RD1A-F6 / BE-002 (C3 long-window resume double-deploy,
  2 attempts). Bound.
- **why:** the same unbound-projection weakness that lets the CLAIM
  drift (FC-001) lets the ACTION repeat. Distrust the impulse to
  "just run it again to be safe" — safe is checking the ledger.
- **scope:** effect-survived/receipt-lost boundary, longer effect
  windows.

## FC-003 — a model-specific observation is not a universal law

- **rule:** never promote a behavior seen under one model/agent/task
  scale to a general claim without the scope attached.
- **evidence:** the E5 lineage (planning-eval was model-specific);
  every Bound Experience here carries a mandatory `scope`. BE-001's
  "task_set adoption is rare" is bound to deepseek-v4-flash + small
  tasks, NOT to kiso in general.
- **why:** an unscoped experience is the loudest form of Unbound
  Projection — it looks like knowledge and generalizes a coincidence.

## FC-004 — a correct experience can outlive its world

- **rule:** an experience whose `validity.invalidatedBy` condition has
  occurred must be retired, not consulted. Check validity before trust.
- **evidence:** BE-003 ("kiso isolates effect subprocesses") is bound
  to `tools-node index.ts:797`; it becomes false the day kiso ships a
  foreground/transaction effect. A memory that kept asserting it would
  be poison.
- **why:** this is the failure mode a naive memory system cannot even
  see — it distrusts nothing it once learned.

## The meta-lesson

A self-improving system (the UP layer, far future) that learns only
its successes learns its own hallucinations. The failure catalog is
the counterweight: the experiences that tell the system where its
reasoning, its actions, its generalizations, and its own past
knowledge stop being trustworthy. EX-0 establishes that these can be
bound to durable evidence exactly like positive experiences — which is
the precondition for ever trusting an automatic version (EX-1).
