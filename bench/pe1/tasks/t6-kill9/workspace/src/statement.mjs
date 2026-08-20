import { Ledger } from "./ledger.mjs";

export function describeLedger(ledger) {
  if (!(ledger instanceof Ledger)) throw new TypeError("describeLedger wants a Ledger");
  const n = ledger.entries().length;
  return `${n} entr${n === 1 ? "y" : "ies"}`;
}
