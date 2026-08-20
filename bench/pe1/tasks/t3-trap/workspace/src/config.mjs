import { readFileSync } from "node:fs";

/** Load the JSON config at `path`. NOTE the shape: this returns a
 *  RESULT OBJECT, never throws on a bad file:
 *  { ok: true, value } | { ok: false, error } */
export function loadConfig(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
