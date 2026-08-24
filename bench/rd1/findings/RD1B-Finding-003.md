# RD1B-Finding-003 — the surrogate cannot answer `ask_user`, and the
# scenario scores the silence as the agent's failure

- **id:** RD1B-F3
- **class:** benchmark integrity / interaction protocol
- **severity:** P1 for the benchmark — it penalises the exact behaviour
  the system under test is designed to produce
- **agent:** the harness (bench/rd1/drivers/kiso)
- **baseline:** bench f0090d7, artifacts rd1b-kiso
- **scenarios:** c9-r2
- **status:** OPEN — needs a spec ruling before the next batch (the
  frozen SCENARIOS.md is amended dated, per the freeze law)

## What happened

c9-r2 was reported as "the model did not finish the task — n=2 variance,
not a recovery-mechanism problem". The durable log says otherwise. The
run ends on:

    seq 1198  tool_call_end  ask_user
      "NOTES.md now has a 4th item ('EXTERNAL: item 4 added by ops')
       added by someone else. How should PLAN.md handle …"
    seq 1342  tool_call_end  ask_user      ← THE SAME QUESTION AGAIN
    seq 1343  permission_decided  approved
    seq 1345  tool_execution_started        ← and nothing after it

The repeat matters and the first report of this finding missed it. A
single unanswered question describes a blocked agent. An identical
question asked twice, with nothing having come back in between,
describes an agent that did not adapt to the silence — which is what
over-asking looks like, and it is the half of this the harness
explanation does not cover.

`surrogate.jsonl` holds two rows for the whole run: `prompt-sent` and
`external-append`. The driver consults the screen for exactly two
needles — `did it apply?` and `approve ` — and has no handler for a
free-form `ask_user` panel at all. So the agent asked, no one answered,
and the leg hit its deadline. c9-r1 never called `ask_user` and passed.

The r1/r2 difference is therefore **whether the model chose to ask a
question**, and the harness scores asking as failing.

## Why this is not a small bug

SCENARIOS.md's frozen surrogate policy opens: *"The driver answers the
agent's questions."* It answers two. And the asymmetry the policy
explicitly defends — *"An agent that asks gets the observable truth; an
agent that guesses is scored on its guess"* — inverts here: the agent
that asked got a deadline, and an agent that guessed would have finished.

## Options for the ruling (not decided)

1. **Score it honestly, don't fix it yet.** A leg that dies waiting on
   an unanswered `ask_user` is `UNRESOLVED — system/harness
   interaction`, never a recovery FAIL. Cheap, truthful, and keeps the
   cell out of any count.
2. **Give the surrogate a general answer policy.** Answering free-form
   questions from workspace artifacts alone is not mechanical, and a
   surrogate that improvises stops being reproducible. Would need a
   frozen, scenario-specific answer table.

**A frozen diagnostic probe now exists to discriminate** (kiso-doc
kiso-rd1b-f3-probe-spec.md): two arms over c9 — the RD-1B condition, and
a scenario-agnostic content-free nudge ("use your judgement and
proceed") — with every question judged by an independent evaluator for
whether the workspace already answered it. Adding a handler and
re-running would NOT have settled this: a cell that passes once someone
replies looks the same whether the question was necessary or not.

Option 1 is the minimum. **Until the ruling, c9-r2's verdict stays
FAIL** — that is what the frozen scorer produces, and the report records
UNRESOLVED only as a declared proposal. The second issue of the report
wrote UNRESOLVED straight into its official grid and derived counts from
it, which is this finding's own argument being used before the process
that authorises it; the third issue reverted that and gives both counts
in a post-hoc appendix.
