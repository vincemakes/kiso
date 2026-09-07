# SPEC — restructure statz without changing what it does

## 1. Goal

statz grew by copy-and-paste: three CSV readers (one of them drifted),
two aggregators, number formatting in three places, and every
command's flag parsing inlined into `src/cli.mjs`. Restructure the
code into the layout of §2 **without changing observable behavior**:
for every input file and every argument vector, stdout, stderr and the
exit code stay byte-identical to today's — every error message, every
column width, every trailing newline, every float that `export` prints.

The suite under `tests/` is the contract and must not be edited. A
hidden battery checks more inputs than the visible suite does, so do
not tune to the visible cases; preserve the behavior itself.

## 2. Target layout (required; the names are exact)

| module | exports | responsibility |
|---|---|---|
| `src/errors.mjs` | `StatzError` — `new StatzError(code, message)`, `.code` is the exit code, `instanceof Error` | the one error type |
| `src/csv.mjs` | `parseCsv(text, options?) → rows`; a row is `{ name, value, unit, tags }` with `value` a number and `tags` a string array (`[]` when the field is empty) | the ONLY CSV reader; throws `StatzError(3, …)` with today's messages |
| `src/stats.mjs` | `aggregate(rows) → groups` sorted by name, a group being `{ name, count, min, max, mean, p50, unit }`; `median(sortedNumbers)` | the ONLY place statistics are computed |
| `src/format.mjs` | `fmt(x)` (two decimals), `pad(s, width)`, `table(header, rows) → string` (today's `summary` layout: two-space gutters, padded columns, each line right-trimmed) | the ONLY number and text formatting |
| `src/options.mjs` | `parseArgs(argv) → { command, file, options }`; `USAGE` | the ONLY flag parsing; throws `StatzError(1, …)` with today's messages; a usage case throws a `StatzError` whose `usage` property is `true` |
| `src/commands/summary.mjs`, `src/commands/top.mjs`, `src/commands/export.mjs` | `run(rows, options) → string` | pure: no file system, no `process`; the string is exactly what the CLI prints |
| `src/cli.mjs` | (entry point) | the ONLY module that reads files and touches `process`: parse args, read, parse CSV, run, print, map a `StatzError` to its exit code |
| `src/index.mjs` | `parseCsv, aggregate, median, StatzError, parseArgs, summary, top, exportRows` | the public API; `summary`, `top`, `exportRows` are the three `run` functions |

`src/summary.mjs`, `src/top.mjs`, `src/export.mjs` and `src/util.mjs`
are removed.

## 3. Mechanical invariants (checked exactly as written here)

1. `src/summary.mjs`, `src/top.mjs`, `src/export.mjs`, `src/util.mjs` do not exist.
2. The string `node:fs` occurs in exactly one file under `src/`: `src/cli.mjs`. No file under `src/` other than `src/cli.mjs` contains the string `"fs"` or `'fs'` either.
3. The token `process.` occurs only in `src/cli.mjs`.
4. `.toFixed(` occurs exactly once under `src/`, in `src/format.mjs`.
5. The header literal `name,value,unit,tags` occurs exactly once under `src/`, in `src/csv.mjs`.
6. Every module in §2 exists and exports what the table says (checked by importing it).

## 4. Known drift you must preserve

The three readers are not identical. `top`'s rejects any blank line
other than the file's final newline (exit 3, `bad line N`, N the
1-based line number), while `summary` and `export` skip blank
(whitespace-only) lines. Preserve each command's behavior; how the
single parser expresses it — an option on `parseCsv`, a pre-check in
the command — is your call.

`export --format json` prints raw floats. Keep accumulating sums in
file order so every mean stays bit-identical.

## 5. Options and defaults

`parseArgs` applies the defaults (`sort` → `"name"`, `n` → `3`, `by`
→ `"mean"`, `format` → `"json"`; `unit` has no default and stays
`undefined`), so a command's `run(rows, options)` never sees a missing
option it has a default for. Flags are processed left to right and the
first problem wins, with today's messages: `missing value for --x`,
`bad value for --x`, `unknown option --x`. A missing command, a
missing file argument or an unknown command prints the usage line to
stderr and exits 1, without the `statz:` prefix.

The `--n` value must match `^[1-9][0-9]*$`.

## 6. README

Add a `## Modules` section to `README.md` listing the layout of §2, one
line per module.

## 7. Out of scope

No new flags or commands, no behavior fixes (the drift in §4 stays),
no dependencies, nothing under `tests/` or `fixtures/` changes,
`package.json` stays as it is.
