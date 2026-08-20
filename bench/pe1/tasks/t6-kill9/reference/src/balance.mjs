import { Journal } from "./journal.mjs";

export function balance(journal) {
  if (!(journal instanceof Journal)) throw new TypeError("balance wants a Journal");
  return journal.entries().reduce((sum, e) => sum + e.amount, 0);
}
