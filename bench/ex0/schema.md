# EX-0 — the Bound Experience schema (v1.1)

A **Bound Experience** is not a memory record — it is an
`assertion + proof obligation`: a reusable claim that carries, and can
be mechanically checked against, the durable evidence that supports it.
The name is deliberate: it is the opposite of the Unbound Projection
that EP-1/TV-1C exist to prevent (a conclusion that drifted from its
facts). An experience the verifier cannot bind to durable logs is not
knowledge; it is a guess wearing knowledge's clothes.

    Experience system cannot certify itself.  (the EX axiom, after RD-1)

So a Bound Experience is judged by an EXTERNAL verifier reading the raw
durable logs — never by any memory asserting "I learned this".

## The four red lines (every field is externally checkable)

    {
      "id": "BE-00N",
      "assertion": "one reusable claim (never a single-run fact)",

      // ① BINDING — why we believe it. Each predicate is machine-checked
      //    against a durable-log slice under evidence/.
      "boundEvidence": [
        { "slice": "evidence/pe1-t1-bugfix-r1.taskset.json",
          "source": "pe1/t1-bugfix-r1", "sourceSha": "…",
          "predicate": { "kind": "event_count", "name": "task_set",
                         "type": "tool_execution_started", "op": "==", "value": 0 } }
      ],
      "support": { "n": 13, "of": 16 },   // honest sample size

      // ② SCOPE — the environment the claim is bound to. A model-specific
      //    behavior may NEVER become a universal law (the E5 lineage).
      "scope": { "model": "deepseek-v4-flash", "agent": "kiso 0.14.0",
                 "taskScale": "small multi-step (200-600 LoC)" },

      // ③ ANTI-EVIDENCE — the exceptions already in the record. A record
      //    with no counter-evidence is a bias incubator.
      "antiEvidence": [
        { "slice": "evidence/pe1-t5-verify-extend-r1.taskset.json",
          "source": "pe1/t5-verify-extend-r1",
          "note": "one session DID adopt task_set (3 starts) — the claim is 'rare', not 'never'" }
      ],

      // ④ VALIDITY / INVALIDATION — the FUTURE conditions that retire it.
      //    Distinct from antiEvidence (past exceptions): this is when a
      //    world change makes a once-true experience stale. A correct
      //    experience that outlives its world becomes poison.
      "validity": {
        "status": "corroborated | provisional | refuted | superseded | invalidated",
        "activeWhile": "the task extension stays advisory (no runtime task gate)",
        "invalidatedBy": [ "a future round that makes task_set load-bearing" ]
      }
    }

## Predicate kinds the verifier understands (v1.1)

- `event_count` — count of events with a given `name`+`type` in the
  slice `op`/`value` (e.g. task_set starts == 0).
- `no_event_named` — no event with `name` appears.
- `ledger_attempts` — distinct effect attempts in an effect-ledger slice
  `op`/`value` (e.g. == 2 for a double-deploy).
- `ledger_ends` — count of `phase:"end"` rows `op`/`value`.
- `final_status` — a STATUS.md-class artifact equals a value (for the
  claim-vs-truth experiences).

A predicate the verifier cannot evaluate mechanically is REJECTED — an
un-checkable binding is no binding.

## What a Bound Experience is NOT

- not a summary the model wrote (that is the Unbound Projection we reject),
- not a memory the system self-certifies,
- not a universal law (scope is mandatory),
- not immortal (validity is mandatory).

## Reproducibility

Every `boundEvidence`/`antiEvidence` slice under `evidence/` is an
EXTRACT of a real durable log (the relevant events only), carrying its
`source` and the source file's sha. The verifier reads the slices, so
`bench/ex0` is self-contained and re-runnable without the full run
trees — while each slice still points back to the exact session it came
from.
