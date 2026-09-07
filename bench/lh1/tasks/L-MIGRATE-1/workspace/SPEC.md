# SPEC — migrate the rule files to format version 2

## 1. Goal

The version-1 rule format accumulated three shapes for what should be
one: `severity` is a number or a numeric string, `enabled` is the string
`"yes"` or `"no"`, `deprecated` is a separate marker, and `when` is a
comma-separated string standing in for a list. Version 2 gives every
field one shape. Migrate the whole tree — every file under `rules/`, the
loader, the validator, the scaffold script and the format documentation
— and retire version 1: it is not supported alongside.

**Nothing observable changes.** `loadRules("rules")` returns, rule for
rule, exactly the normalized objects it returns today, and every `lintr`
command prints exactly the same bytes for the same arguments. The suite
under `tests/` is the contract and must not be edited; a hidden battery
checks more arguments and inputs than the visible suite shows.

## 2. Version 2

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

| version 1 | version 2 |
|---|---|
| — | `schema`: the number `2`; required |
| `severity`: `0`/`1`/`2`, number or numeric string | `level`: `"off"`/`"warn"`/`"error"`; required |
| `when`: `"a, b"` or `"*"` | `files`: `["a", "b"]` or `["*"]` — each kind trimmed, empty entries dropped; required, non-empty |
| `enabled`: `"yes"`/`"no"`/absent | `enabled`: `true`/`false`/`true`; required |
| `pattern`, `message` (top level) | `match`: `{ "pattern": …, "message": … }`; required, both strings |
| `deprecated: true` | the tag `"deprecated"` appended to `tags` (creating the array if absent); the key no longer exists |
| `id`, `description`, `extends`, `fix`, `options`, `tags`, `examples` | unchanged; `id` and `description` required, the rest optional |

A rule that `extends` another still inherits every optional key it
omits, exactly as today. The required keys are required even then (every
rule in the tree already carries them). In the normalized form nothing
changes: `deprecated` is `true` when `tags` contains `"deprecated"`, and
the normalized `tags` does not contain that marker.

Write the files as 2-space-indented JSON with a trailing newline, keys
in the order shown above (a convention, not a checked invariant).

## 3. Loader and validator

`src/loader.mjs` keeps `loadRules(dir)` and `RuleError` with their
names, signatures and the message form `<file>: <reason>`. Rules:

- A file without a `schema` key throws `RuleError(file, "missing schema")`
  — that is what every version-1 file is; a file whose `schema` is present
  but not the number 2 throws `RuleError(file, "unsupported schema <value>")`
  (`unsupported schema 1`). This is the first check after the
  file-name/id checks.
- The existing reasons stay as they are: `invalid JSON (…)`,
  `missing id`, `id <x> does not match the file name`,
  `extends unknown rule <x>`, `extends cycle`, `invalid pattern`,
  `missing pattern`, `missing message`.
- New reasons: `level must be off, warn or error`,
  `files must be a non-empty array of strings`,
  `enabled must be a boolean`.

`src/schema.mjs` keeps `validateRule(name, data) → string[]`. Its
messages, one per problem: `schema must be 2`, `unknown key <k>`,
`id must be a non-empty string`, `id must match the file name`,
`description must be a string`, `extends must be a string`,
`level must be off, warn or error`,
`files must be a non-empty array of strings`,
`enabled must be a boolean`,
`match must have pattern and message strings`,
`fix must be null, a string or an object`, `options must be an object`,
`tags must be an array of strings`,
`examples must have bad and good arrays`, and `missing <k>` for every
missing required key other than `schema` (whose absence is
`schema must be 2`). The tests check the set of messages, not their
order.

## 4. The scaffold

`scripts/new-rule.mjs` emits version 2. Its flags follow the fields:
`--level off|warn|error` (default `warn`) replaces `--severity`,
`--files a,b` (default `*`) replaces `--when`; `--dir` stays.

## 5. Documentation

`docs/RULE-FORMAT.md` documents version 2 and shows no version-1 key:
the strings `"severity"` and `"when"` do not occur in it; `"schema": 2`
does (the tag `"deprecated"` is a version-2 concept and may be named). `docs/CHANGELOG.md` is history and is not
edited by this migration (the release note is written at release time).
`README.md` may be adjusted where it names a flag.

## 6. Mechanical invariants (checked exactly as written)

1. Every `rules/*.json` parses, has `"schema": 2`, and has none of the
   top-level keys `severity`, `when`, `deprecated`, `pattern`, `message`;
   its `enabled` is a boolean.
2. The set of rule ids is unchanged (30 files, the same names).
3. `loadRules("rules")` equals today's output rule for rule (the
   evaluator computes today's from the original tree).
4. `docs/RULE-FORMAT.md`: contains `"schema": 2`; contains neither
   `"severity"` nor `"when"`.
5. Every `lintr` command prints the same bytes as today.
6. `tests/`, `fixtures/`, `SPEC.md`, `package.json` and
   `docs/CHANGELOG.md` are unchanged.

## 7. Out of scope

No new rules, no behavior changes, no new `lintr` commands or flags,
no dependencies.
