/**
 * RD1B-F9 — the auto-generated session id, in ONE place.
 *
 * It used to be this expression, copied at four call sites:
 *
 *     new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)
 *
 * which stops at the MINUTE and carries no entropy. `SessionStore` is one
 * file per id (`store.ts`), so two sessions started in the same minute were
 * the same session: the second launch presented as fresh and transparently
 * appended to the first one's durable log. Demonstrated in
 * `tests/session-id-identity.test.ts`.
 *
 * Not a race — the store's single-writer link lock (ADR-0050) already fails
 * simultaneous writers loudly, and `storage.test.ts` pins that. This was
 * sequential identity ALIASING, which no lock can see.
 *
 * The id keeps the one property anything depends on: **lexicographic order
 * is time order**, because `listSessions` sorts with `id.localeCompare`
 * and nothing anywhere parses an id back into a date. Seconds extend the
 * stamp monotonically; the suffix only breaks ties inside a single second.
 *
 * Old ids are untouched — no rename, no migration. They still resume by id
 * and still sort before same-minute new ids.
 */

import { randomBytes } from "node:crypto";

/** A fresh session id: `YYYY-MM-DDTHH-MM-SS-xxxx`, sortable, collision-safe
 *  for practical purposes at any launch rate a human or a script produces. */
export function newSessionId(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19); // to the second
	return `${stamp}-${randomBytes(2).toString("hex")}`;
}
