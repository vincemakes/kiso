# Rule files

Every file under `rules/` is one rule, `rules/<id>.json`, and `id` must
equal the file name.

## Format (version 2)

```json
{
  "schema": 2,
  "id": "no-tabs",
  "description": "Tabs are not allowed in source files.",
  "level": "error",
  "files": ["js", "ts"],
  "enabled": true,
  "match": { "pattern": "\\t", "message": "tab found" },
  "fix": null,
  "options": { "allowInStrings": false },
  "tags": ["style"],
  "examples": { "bad": ["\tx"], "good": ["  x"] }
}
```

| key | meaning |
|---|---|
| `schema` | the number `2`; a file without it is refused (`missing schema`), any other value too (`unsupported schema`) |
| `level` | `"off"`, `"warn"` or `"error"` |
| `files` | the file kinds the rule applies to, e.g. `["js", "ts"]`, or `["*"]` for every kind |
| `enabled` | `true` or `false` |
| `match` | `pattern`, a JavaScript regular expression tested against every line, and `message`, the finding's text |
| `fix` | `null`, a fixer name, or an object |
| `options`, `tags`, `examples` | free-form; defaults `{}`, `[]`, `{ "bad": [], "good": [] }` |
| the tag `"deprecated"` | marks a rule that is kept for its history and never applied; it is not reported as a tag |
| `extends` | another rule's id; every optional key this rule omits is inherited from it |

`schema`, `id`, `description`, `level`, `files`, `enabled` and `match`
are required; the rest are optional.

`node scripts/new-rule.mjs <id> <description> [--level warn] [--files js,ts]`
scaffolds a file in this form; `node src/cli.mjs validate` checks every
file against it.
