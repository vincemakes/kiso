# lintr

A line-pattern linter driven by rule files under `rules/`.

    node src/cli.mjs list [--kind js] [--rules <dir>]
    node src/cli.mjs check <file>... [--rules <dir>]
    node src/cli.mjs validate [--rules <dir>]

`list` prints every rule (or, with `--kind`, the rules that apply to
that file kind); `check` prints `file:line: level id: message` for every
match and exits 1 when any error-level finding exists; `validate` checks
every rule file against the schema. The rule-file format is documented
in `docs/RULE-FORMAT.md`; `node scripts/new-rule.mjs` scaffolds one.

## Exit codes

- 1 — usage, a bad option, or (for `check`) an error-level finding
- 2 — a file or the rules directory cannot be read
- 3 — a rule file cannot be used (`lintr: <file>: <reason>`)

## Tests

    npm test
