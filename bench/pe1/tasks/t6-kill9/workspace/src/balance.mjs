import { Ledger } from "./ledger.mjs";

export function balance(ledger) {
  if (!(ledger instanceof Ledger)) throw new TypeError("balance wants a Ledger");
  return ledger.entries().reduce((sum, e) => sum + e.amount, 0);
}
