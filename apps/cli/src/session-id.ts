/**
 * RD1B-F9 — the auto-generated session id, in ONE place.
 *
 * It used to be this expression, copied at four call sites:
 *
 *     new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)
 *
 * which stops at the MINUTE and carries no entropy. `SessionStore` is one
 * file per id, so two sessions started in the same minute were the same
 * session: the second launch presented as fresh and transparently appended
 * to the first one's durable log (`tests/session-id-identity.test.ts`).
 *
 * WHAT THE GUARANTEE IS, precisely — because the first version of this
 * comment claimed "collision-safe at any launch rate a human or a script
 * produces" and that was an unmeasured claim that is false. A 16-bit
 * suffix collides at script rates: 100 launches inside one second carry a
 * 7.3% chance of at least one collision, and 1,000 produce a handful every
 * time. Measured, not modelled.
 *
 * So the id does not rest on entropy at all:
 *
 *   - SEQUENTIAL collision is eliminated BY CONSTRUCTION. `newSessionId`
 *     is handed the sessions directory and will not return an id whose
 *     durable log or lock already exists; it draws again. Entropy only
 *     decides how often it has to draw.
 *   - CONCURRENT collision — two processes drawing the same id before
 *     either has written — remains possible and is already handled
 *     correctly one layer down: the store's single-writer link lock
 *     (ADR-0050) fails the second writer loudly, and `storage.test.ts`
 *     pins that. Loud failure is the right outcome there; silent sharing
 *     was the defect.
 *
 * The id keeps the one property anything depends on: **lexicographic order
 * is time order**, because `listSessions` sorts with `id.localeCompare`
 * and nothing anywhere parses an id back into a date. Seconds extend the
 * stamp monotonically; the suffix only breaks ties inside one second.
 *
 * It also stays 24 characters — exactly the session picker's id column cap
 * (`packages/tui/src/session-picker.ts:112`). Widening the suffix instead
 * of checking for collisions would have pushed the distinguishing tail out
 * of the column, hiding the very bytes that make two ids different.
 *
 * Old ids are untouched — no rename, no migration. They still resume by id
 * and still sort before same-minute new ids.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** How many draws before giving up. Reaching this means either the clock
 *  is frozen or the directory holds ~every suffix for this second; both
 *  are worth failing loudly over rather than returning a colliding id. */
const MAX_DRAWS = 50;

const stampOf = (now: Date, suffix: string): string => `${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${suffix}`;

/**
 * A fresh session id: `YYYY-MM-DDTHH-MM-SS-xxxx`, sortable, and — when
 * `dir` is given — guaranteed not to name a session that already exists
 * there.
 *
 * `rand` is injectable so the collision path can be tested; production
 * never passes it.
 */
export function newSessionId(dir?: string, now: Date = new Date(), rand: () => string = () => randomBytes(2).toString("hex")): string {
	if (dir === undefined) return stampOf(now, rand());
	for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
		const id = stampOf(now, rand());
		// The store writes `<id>.jsonl` and takes `<id>.lock`; either one
		// present means the id is spoken for, including by a session that
		// has locked but not yet appended.
		if (!existsSync(join(dir, `${id}.jsonl`)) && !existsSync(join(dir, `${id}.lock`))) return id;
	}
	throw new Error(`could not draw an unused session id in ${dir} after ${MAX_DRAWS} attempts`);
}
