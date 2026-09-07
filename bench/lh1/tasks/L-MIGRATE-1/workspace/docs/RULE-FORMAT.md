# Rule files

Every file under `rules/` is one rule, `rules/<id>.json`, and `id` must
equal the file name.

## Format (version 1)

```json
{
  "id": "no-tabs",
  "description": "Tabs are not allowed in source files.",
  "severity": 2,
  "when": "js,ts",
  "enabled": "yes",
  "pattern": "\\t",
  "message": "tab found",
  "fix": null,
  "options": { "allowInStrings": false },
  "tags": ["style"],
  "examples": { "bad": ["\tx"], "good": ["  x"] }
}
```

| key | meaning |
|---|---|
| `severity` | `0` off, `1` warn, `2` error (a numeric string is accepted) |
| `when` | comma-separated file kinds (`js,ts`), or `*` for every kind; spaces around a kind are ignored |
| `enabled` | `"yes"` or `"no"`; absent means yes |
| `pattern` | a JavaScript regular expression tested against every line |
| `message` | the finding's text |
| `fix` | `null`, a fixer name, or an object |
| `options`, `tags`, `examples` | free-form; defaults `{}`, `[]`, `{ "bad": [], "good": [] }` |
| `deprecated` | `true` marks a rule that is kept for its history and never applied |
| `extends` | another rule's id; every key this rule omits is inherited from it |

`node scripts/new-rule.mjs <id> <description>` scaffolds a file in this
form; `node src/cli.mjs validate` checks every file against it.
