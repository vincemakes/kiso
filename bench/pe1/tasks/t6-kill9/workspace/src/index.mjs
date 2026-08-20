import { Ledger } from "./ledger.mjs";
export { balance } from "./balance.mjs";
export { describeLedger as describeBook } from "./statement.mjs";

/** The stable public factory — tests depend on THIS name only. */
export function openBook() {
  return new Ledger();
}
