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
