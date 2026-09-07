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

## Currencies

A posting may carry a fifth field, its currency code (`USD`, `EUR`,
`GBP`, `JPY`, `KWD`): `2026-01-07 | assets:bank | 100.00 | transfer | EUR`.
Without it the journal's default currency applies — `USD`, or the one
named by a header line `; default-currency: EUR` placed before any
posting. Amounts use each currency's minor unit (JPY has none, KWD has
three decimals).

A rates file holds one rate per line, `EUR USD 1.10` meaning 1 EUR =
1.10 USD; the inverse direction is derived. Conversions round ties to
even.

- `node src/cli.mjs fx <journal> --base USD --rates rates.txt` — each
  account converted to the base currency, then `TOTAL`.
- `node src/cli.mjs summary <journal> --base USD --rates rates.txt` —
  the net in the base currency.

A conversion with no usable rate exits 4 with `no rate: FROM->TO`.
