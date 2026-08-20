// Restored from tests/helpers-fmt.mjs.bak (the directory move healed).
import { formatNote } from "../../src/format.mjs";

export function fmtHelper(notes) {
  return notes.map(formatNote).join("|");
}
