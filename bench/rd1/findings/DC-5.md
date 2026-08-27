# DC-5 — WITHDRAWN: kiso does not flicker on a partial closing fence

- **id:** DC-5
- **class:** rendering / streaming stability
- **severity:** none — the defect does not exist here
- **agent:** kiso 0.16.2
- **status:** WITHDRAWN by its own author, before any code was written

## What was claimed

That a fenced code block grows and loses a row as its closing fence
streams in one backtick at a time, because the reference implementation
carries a named fix for exactly that and kiso appeared to reproduce it.

## Why it was wrong

The repro used `renderMarkdown(text, W)`, which is `push(text)` followed
immediately by `end()`. `end()` deliberately treats the trailing partial
line as a complete line — that is its contract, because a message that
has ended has no more newlines coming. So the repro did not simulate a
fence streaming in; it simulated **a message ending mid-fence four
times**, and in that case rendering the stray backtick is correct: it is
content the model actually emitted.

## The real streaming path, measured

Deltas fed to `MdStream` one at a time, rows counted after each:

| delta | rows |
|---|---|
| `` ```ts\n `` | 1 |
| `const a = 1;\n` | 2 |
| `` ` `` | 2 |
| `` ` `` | 2 |
| `` ` `` | 2 |
| `\n` | 2 |
| `done\n` | 4 |

Stable throughout.

**Correction to the mechanism first given here.** I wrote that `push`
only feeds complete lines, so a partial fence never reaches the
renderer. That is wrong, and T-MD-5 says so: inside a fence a partial
line DOES render, deliberately — "the partial line renders NOW, with the
gutter, without closing". What the scanner suppresses is specifically a
partial line that looks like a closing fence. kiso therefore has the
reference implementation's fix already, in its scanner rather than as a
post-pass over tokens. The measurement above was right; the reason I
gave for it was not.

## Why kiso is structurally immune

Both renderers show the incomplete tail of a fenced block, and both
therefore have to decide what a half-typed closing fence is. The
reference implementation decides it in a pass over the parsed tokens;
kiso decides it in the scanner, where the line is classified. Same
answer, earlier.

## The observation that is real, and is not a defect

Outside a fence the incomplete line does not render, so the line the
model is currently typing is invisible until its newline arrives. Inside
a fence it does. The asymmetry is deliberate — a prose line's shape
depends on words that have not arrived, a code line's does not.

## The lesson worth keeping

A helper that ends a stream is not a stand-in for the stream. The next
time a streaming claim is tested, it gets tested through `push()` deltas
— never through the batch convenience wrapper.
