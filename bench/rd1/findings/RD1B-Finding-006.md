# RD1B-Finding-006 — the dock-less `ask_user` says it declined, then blocks forever

- **id:** RD1B-F6
- **class:** decision-surface / copy contradicts behaviour
- **severity:** P1 — an unattended agent stops permanently on a surface
  that reports itself resolved
- **agent:** kiso 0.15.1 (published)
- **baseline:** bench f0090d7, artifacts rd1b-kiso
- **scenarios:** c9-r2 (the failure it explains)
- **status:** OPEN — demonstrated, not yet fixed. Priority RAISED by the
  RD1B-F3 probe: asking is rare (1 of 14 recorded c9 runs), so this
  hangs rarely and then hangs forever — a low-frequency,
  unbounded-consequence failure, which is harder to notice than a
  frequent one, not easier.

## The behaviour

On a tty too small for the dock (rows < 4 — the RD-1 driver's surface),
`ask_user` renders through `askPanel`'s fallback:

    ⚠ <question> — this terminal cannot show the option panel; the question is declined

The sentence is in the past tense and describes a resolved state. The
code does not resolve anything: `askPanel` calls `input.question(...)`
and **waits for a line, indefinitely**. When a line finally arrives, any
line, `askUi` maps every non-`answers` verdict to `askDeclineAll` — so
the text was right about the outcome and wrong about the timing, and the
content of whatever was typed is discarded.

Reproduced directly (faux provider, 1-row pty, no model):

    fallback appeared at +0.1s; waiting 5s with no input
    after 5s: continued=False  -> BLOCKS
    a line unblocked it at +0.0s
    [result] {"declined":["Which bundler should I use? (vite, webpack)"]}

## Why it matters more than a copy bug

Nothing in the environment has any reason to send that line. A human
reading "the question is declined" has been told the interaction is
over. A harness driving the CLI has been told the same. The agent waits
for input that the surface has just announced is unnecessary — so the
run does not fail, it stops, and stops silently.

This is the same family as RD1B-F1: dock-less copy that misdescribes
what the code does, on a surface only reachable when no dock can render.
F1 inverted an answer; F6 announces an outcome it has not reached.

## What it corrects

RD-1B's c9-r2 was attributed first to model variance, then to a harness
gap (no `ask_user` handler), then — after a review counted two
`ask_user` calls — partly to kiso over-asking. **All three readings were
wrong, and the third was wrong in a way worth recording.** The two calls
are not a repeat:

    seq 1198  ask_user  header='PLAN.md items'  (13 chars)
    seq 1199  tool_result isError=true
              "Arguments failed schema validation:
               /questions/0/header must NOT have more than 12 characters"
    seq 1342  ask_user  header='PLAN items'     (10 chars)

kiso's own schema (`ASK_HEADER_CAP = 12`) rejected the first call and
the agent corrected it. That is adaptation, the opposite of what the
repeat was read as. Counting `tool_call_end` events without reading the
`tool_result` between them produced the error.

So c9-r2 is: the agent asked one question, correctly, and the surface it
asked through hung while claiming it had not.

## Fix shape (not implemented)

The fallback must do what it says. Either decline immediately without
waiting — the honest reading of the current sentence — or wait and say
so ("this terminal cannot show the options; press enter to decline").
The first is preferable: a question that cannot be presented has no
answer available, and blocking a non-interactive run on input nobody
knows to send is the failure this finding is about.

Whichever is chosen, the dock-less ask needs the same two-direction
end-to-end test RD1B-F1 got, asserted against the durable log.
