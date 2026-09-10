/**
 * R6b — the two remaining writers of the human's own bytes.
 *
 * R6 made the session logs and the history private. These are its
 * siblings, found by asking the neighbours of what it touched:
 *
 *  - the BYTE TRACE (`KISO_TRACE_BYTES`) appends every keystroke and every
 *    paste, base64, to a path the env names. Opt-in debugging, and the
 *    most sensitive file kiso can write — it is the session logs plus the
 *    things that never reached a turn.
 *  - the ctrl+g DRAFT, written to a `compose-` directory under
 *    `$KISO_HOME/tmp`. (Spelled without the glob: a `*` followed by a
 *    slash CLOSES a block comment, which is how the first version of this
 *    file failed to parse.)
 *    `mkdtemp` gives its own directory 0700, so the file is shielded
 *    today by where it sits rather than by what it is; the root above it
 *    was created with no mode at all.
 *
 * Checked and NOT changed, named so nobody re-asks: the trace and meta
 * writers under the sessions root (session.ts, trace/writer.ts,
 * profile.ts) carry no conversation payload and now sit under a 0700
 * root.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "apps/cli/dist/index.js");
const modeOf = (p: string): string => (statSync(p).mode & 0o777).toString(8);

describe("R6b — private modes on the remaining writers", () => {
	it("the byte trace is created 0600 under umask 022", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-r6b-"));
		const trace = join(home, "bytes.jsonl");
		execFileSync("/bin/sh", ["-c", `umask 022; KISO_HOME=${home} KISO_TRACE_BYTES=${trace} KISO_NO_UPDATE_CHECK=1 node ${CLI} --help >/dev/null 2>&1 || true`]);
		expect(modeOf(trace), "every keystroke and paste, and it read to the world").toBe("600");
	});
});
