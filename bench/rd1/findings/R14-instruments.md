# R14 — the instruments were wrong eight times, and that is the finding

- **id:** R14-INSTRUMENTS
- **class:** methodology, not a product defect
- **round:** R14 / route B (0.25.0)
- **status:** recorded for the next round. Two rules at the bottom.

Route B produced four product changes and eight false readings. The
false readings cost more time than the changes did, and every one of
them had the same shape: **a measurement that looked like a result.**
They are written down here rather than in `design.md`, which is the
contract and not a lab notebook.

Ordered by what each cost.

## 1. The PTY suite runs `dist`, and a rebuild is not optional

The fix for `search_text`'s missing rows was made, typechecked, and
tested — against the previous build. `dc34-widen-seam` reported 36
tokens missing from the scrollback and the reading was of code that no
longer existed. A `npm run build` run later for an unrelated reason
turned it green on its own.

Cost: most of an investigation into a defect that was already fixed.
It is also the one item on this list that was already written down, in
this session's own memory, before the session began.

**Corollary discovered the same day, in the other direction:** never
run `npm run build` while the PTY suite is running. The suite drives
`dist`, so a rebuild mid-run has it testing a mixture of two versions.

## 2. Both terminal emulators ignored ED's parameter

`Screen` and `VtScrollback` both implemented `J` as ED0 — erase from
the cursor down — whatever parameter it carried. Harmless for as long
as kiso only ever wrote `\x1b[0J`. Route B writes `2J` (the screen) and
`3J` (the SCROLLBACK), and an emulator that treats `3J` as ED0 keeps
the pre-reprint history AND receives the reprint on top, so a correct
reprint reads as duplication.

Three gates went red for it (`dc33-resize-midturn` ×2,
`dc34-widen-seam`) and later a fourth (`tt1-clamp`, 32 rows "doubled").
Every one of them was the instrument.

## 3. Two gate fixtures were green against the defect they named

Building the `search_text` liveness gate, twice:

- **32 MiB file, 120 ms threshold** — green. `readFileSync` of 32 MiB
  is 36 ms here; even 256 MiB is 163 ms. The threshold was guessed and
  never measured.
- **2 GiB SPARSE file** — instant to create, and the exact shape of the
  file that froze the owner's machine. Green for a worse reason: 2 GiB
  is past V8's maximum string length, so the broken code THREW into its
  bare `catch {}` and the file never appeared in the output. Both the
  skip assertion and the liveness assertion were satisfied *by the
  defect*.

What discriminates is a fixture the broken code READS SUCCESSFULLY and
is slow doing: 128 MiB of real text, measured at 200/328/200 ms of
stall across three trials, 39 ms to write.

## 4. The stall meter never recorded the stall

`longestLoopStall` sampled the event loop on a `setInterval` and
cleared it as soon as the awaited call resolved. An awaited chain
resolves through MICROtasks, which run before timers — so the interval
was cleared before it could fire and record the 300 ms it had just sat
through. Both liveness cases were green over measured blockage.

The final gap has to be taken explicitly when the work returns, not
left to the timer.

## 5. Under fake timers, `process.hrtime` is faked too

G9's first measurement reported "200.0 ms of work" against a "200.0 ms
baseline" — both were the fake clock's advance, and the difference was
identically zero. The real figure, on real timers, is 1-2 ms. Two
orders of magnitude, in a number a release report carries.

## 6. A unit-level reproduction that reproduced the harness

An attempt to reproduce `dc34`'s missing rows at unit level lost 11 of
24 marks **with no resize at all**. The harness could not drive
streaming text under fake timers and read the emulator; any resize
claim built on it would have been a claim about the harness.

Caught by the cheapest possible discriminator: remove the variable
under test and see whether the failure survives.

## 7. Instrumentation that changed what it measured

A diagnostic written to `process.stderr` inside a PTY child is injected
into the captured byte stream. Held rows went from 32 to 51 and the
failing case passed. (A later attempt used `require` in an ESM module
and killed the CLI outright — 119 of 120 tokens missing, which looks
like catastrophe and is a syntax error.)

Diagnostics from a process whose OUTPUT is the measurement go to a
file.

## 8. `origin/main` is a snapshot, and a stale one by default

Reported to the round's author, twice, that nothing had been pushed —
"remote: zero". It was read off the local remote-tracking ref without a
`git fetch`. A `fetch` showed `origin/main` six commits ahead of what
that ref said: another lane had pushed main, and because their work sat
on top of this round's, the push carried six of this round's commits to
the remote with it.

Nobody did anything wrong — that is how a shared branch works — but the
claim was false, and it was load-bearing: the ruling that followed
offered a rebase on the explicit grounds that "nothing is pushed, so it
is technically safe". It was not safe; those commits were public, and
the option evaporated when the fact was checked.

`git status` does not fetch. Neither does `git log origin/main`. In a
tree several sessions share, the remote-tracking ref is a snapshot of
the last time someone looked, and the default assumption should be that
it is out of date.

**"Nothing has been pushed" is a claim about the world, not about the
working copy. Go and look before making it.**

---

## The two rules

**1. On every red, ask "product or instrument" before debugging the
product.** Five of the seven above presented as product defects. The
discriminator is usually cheap and always cheaper than the alternative:
remove the variable under test and see whether the failure survives, or
run the same scenario through a second instrument.

**2. A non-vacuity guard is not optional.** Two empty lists are equal;
a byte-identical comparison over an empty region is green; a needle
that never appears means the scenario never ran. Every case that
compares, matches, or measures states first that there was something to
compare, match or measure. In this round that guard is what caught the
`kill -9` gate killing nothing (its needle, the recap glyph followed by
a word, is never contiguous on the wire because the recap puts SGR
codes between them) and what stopped three separate green-against-the-
defect gates from shipping.

Corollary to rule 2, learned twice here: **when a threshold is the
gate, measure both states before choosing it.** A threshold picked from
intuition is a coin flip, and a gate that is green against the defect it
names is worse than no gate — it is a standing claim that the defect
cannot happen.
