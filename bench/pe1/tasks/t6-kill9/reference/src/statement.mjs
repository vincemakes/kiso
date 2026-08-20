import { Journal } from "./journal.mjs";

export function describeJournal(journal) {
  if (!(journal instanceof Journal)) throw new TypeError("describeJournal wants a Journal");
  const n = journal.entries().length;
  return `${n} entr${n === 1 ? "y" : "ies"}`;
}
