# statz

A small reporter over measurement CSVs.

    name,value,unit,tags
    latency,12.5,ms,api;web

Tags are `;`-separated; the header line is required.

## Commands

    node src/cli.mjs summary <file> [--unit <unit>] [--sort name|mean]
    node src/cli.mjs top <file> [--n <k>] [--by mean|max]
    node src/cli.mjs export <file> [--format json|csv]

`summary` prints one table row per name (count, min, max, mean, p50,
unit). `top` prints the k names with the highest mean (or max).
`export` prints the aggregated rows as JSON (default) or CSV.

## Exit codes

- 1 — usage or a bad option (`statz: unknown option --x`, `statz: bad value for --n`)
- 2 — the file cannot be read
- 3 — the file is malformed (`bad header`, `bad line N`, `bad value on line N`)

## Tests

    npm test

## Modules

- `src/cli.mjs` — the entry point; the only module that reads files and touches `process`
- `src/options.mjs` — `parseArgs(argv)` and `USAGE`; every flag, default and message
- `src/csv.mjs` — `parseCsv(text, { blankLines })`; the one reader (`top` rejects blank lines, the others skip them)
- `src/stats.mjs` — `aggregate(rows)` and `median(sorted)`
- `src/format.mjs` — `fmt`, `pad`, `table`
- `src/commands/summary.mjs`, `src/commands/top.mjs`, `src/commands/export.mjs` — pure `run(rows, options) → string`
- `src/errors.mjs` — `StatzError(code, message)`
- `src/index.mjs` — the public API
