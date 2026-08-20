import { Journal } from "./journal.mjs";
export { balance } from "./balance.mjs";
export { describeJournal as describeBook } from "./statement.mjs";

/** The stable public factory — tests depend on THIS name only. */
export function openBook() {
  return new Journal();
}
