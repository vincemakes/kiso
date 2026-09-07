# Changelog

## 1.3.0

- `extends`: a rule may inherit from another (`base-naming` and the two naming rules).
- `deprecated` marker; deprecated rules are listed but never applied.

## 1.2.0

- `lintr validate` checks every rule file against the schema.
- `scripts/new-rule.mjs` scaffolds a rule.

## 1.1.0

- `fix`, `options`, `tags`, `examples` keys.
- `severity` accepts a numeric string (imported rule sets used `"2"`).

## 1.0.0

- `lintr list` and `lintr check` over `rules/*.json` (version 1 format).
