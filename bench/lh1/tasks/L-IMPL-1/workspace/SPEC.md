# SPEC — multi-currency postings

Implement multi-currency support across the ledger. Everything below is
required; the visible test suite must stay green and untouched; the
existing `balance` and `summary` output for a USD-only journal must
stay byte-identical.

## 1. Currencies (new module `src/currency.mjs`)

A currency has a 3-letter uppercase code and a minor-unit exponent:
`USD` 2, `EUR` 2, `GBP` 2, `JPY` 0, `KWD` 3. Export `exponent(code)`
(throws `Error("unknown currency: X")` for others) and `isCurrency(s)`.

## 2. Money (`src/money.mjs`)

`parseAmount(text, currency = "USD")` parses a decimal string into an
integer of MINOR units for that currency: `"12.50"` → 1250 (USD),
`"1200"` → 1200 (JPY), `"1.234"` → 1234 (KWD). More decimals than the
exponent → `Error("too many decimals")`. `formatAmount(minor, currency
= "USD")` renders with exactly the exponent's decimals (`1250` → "12.50";
JPY `1200` → "1200"; KWD `1234` → "1.234"), negative as `-3.25`.
`roundHalfEven(x)` rounds a number to the nearest integer, ties to the
even neighbour (banker's rounding): 2.5 → 2, 3.5 → 4, -2.5 → -2.

## 3. Journal (`src/journal.mjs`)

A posting line gains an OPTIONAL fifth field, the currency:
`2026-01-07 | assets:bank | 100.00 | transfer | EUR`. A missing fifth
field means the journal's default currency, which is `USD` unless a
header line `; default-currency: EUR` appears before any posting (a
comment line with exactly that shape). `parseJournal(text)` returns
entries `{ date, account, amount, memo, currency }` where `amount` is in
that currency's minor units. A fifth field that is not a known currency
is a parse error (`Error("unknown currency: …")`).

## 4. Rates (`src/rates.mjs`, new)

`parseRates(text)` reads lines `EUR USD 1.10` (1 EUR = 1.10 USD; `;`
comments allowed) into a rates table. `convert(minor, from, to, rates)`
returns minor units of `to`: identity when `from === to`; uses a direct
rate, or the INVERSE of the reverse rate (`USD→EUR` from `EUR USD
1.10`), rounding with `roundHalfEven` after applying the exponents
(`convert(1000, "EUR", "USD", {EUR/USD 1.10})` → 1100; `convert(1100,
"USD", "EUR", …)` → 1000; `convert(150, "USD", "JPY", {USD JPY 150})`
→ 225). No rate → `Error("no rate: FROM->TO")`.

## 5. Ledger (`src/ledger.mjs`)

`balances(entries)` and `totalsByPrefix(entries, prefix)` keep their
shapes and results for single-currency journals (the visible suite
pins them); on a journal that mixes currencies they throw
`Error("mixed currencies: use balancesByCurrency")`. New:
`balancesByCurrency(entries)` returns a Map account → Map currency →
minor units, and `totalsByPrefixByCurrency(entries, prefix)` a Map
currency → minor units.

## 6. Report (`src/report.mjs`)

`balanceReport(entries)` prints one line per account per currency:
`account  amount CCY` — for a USD-only journal the output must be
byte-identical to today's (no currency suffix). `fxReport(entries, base,
rates)` prints, per account, its balance converted to `base` (each
currency converted and summed), then a final line `TOTAL  amount BASE`;
lines sorted by account. `summary(entries, base?, rates?)`: with a base,
the `net` line is the converted net in the base currency.

## 7. CLI (`src/cli.mjs`)

New flags `--base <CCY>` and `--rates <file>`; a new subcommand
`fx <journal> --base <CCY> --rates <file>` printing `fxReport`. A
conversion that needs a missing rate exits **4** with `no rate: …` on
stderr. Usage errors stay exit 2, parse errors exit 3.

## 8. Docs

README gains a "Currencies" section describing the fifth field, the
default-currency header, the rates file and the `fx` command.

## Constraints

Do not modify anything under `tests/`. Do not delete or rewrite
unrelated files. Keep every existing command's output byte-identical for
USD-only journals.
