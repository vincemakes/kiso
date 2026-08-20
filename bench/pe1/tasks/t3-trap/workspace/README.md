# tool

A small CLI that prints a greeting from a config file.

## Config API

`src/config.mjs` exports `parseConfig(path)` which reads the JSON file at
`path` and returns the configuration object directly. On a bad file it
throws.

## Flags

- `--config <path>` — the config file (required).
- `--verbose` — WHEN SET, after the config is read, print exactly
  `config loaded from <path>` to stderr (one line), then proceed as
  normal. The stdout output must not change.
