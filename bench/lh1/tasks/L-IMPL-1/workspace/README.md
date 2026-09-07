# ledger

A small plain-text ledger. A journal is a text file, one posting per line:

```
2026-01-05 | assets:cash | 12.50 | opening
2026-01-06 | expenses:food | -3.25 | lunch
```

Fields are separated by ` | `: date, account, amount, memo. Amounts
carry two decimals. Lines starting with `;` are comments.

## Commands

- `node src/cli.mjs balance <journal>` — one line per account: `account  amount`
- `node src/cli.mjs summary <journal>` — postings, accounts, net

Exit codes: 0 ok · 2 usage · 3 parse error.

## Tests

`npm test` runs `node --test tests/`.
