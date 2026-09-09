/**
 * §2.4 — the RUN half of ctrl+g.
 *
 * The dispatcher routes and this runs: it owns the temp file and the
 * spawn, and knows nothing about the composer, the body or the session.
 * Everything it needs arrives as an argument, which is what lets the
 * dispatcher reach it through `await import(...)` at the call rather than
 * a static import.
 *
 * That laziness is load-bearing, not stylistic. The PTY manifest gate
 * classifies a test by the RESOURCE closure of what it imports, so a
 * static `node:child_process` anywhere in dispatch.ts reclassifies every
 * test that imports dispatch — a millisecond-long parser test for `!cmd`
 * was moved into the single-file-serial pool by this module's first
 * shape. A module the dispatcher only loads when the key is pressed is
 * honestly outside that closure: nothing that merely imports the
 * dispatcher can spawn anything.
 *
 * The failure contract is the whole point of the return type: `null`
 * means KEEP WHAT WAS THERE. A failed edit must not eat what the human
 * had already written.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Run `bin` on `text` and return what came back, or `null` when the edit
 * failed — in which case `onFailure` has already been told, in one line,
 * what went wrong.
 *
 * @param root  the directory temp files live under (`$KISO_HOME/tmp`)
 */
export function runExternalEditor(bin: string, root: string, text: string, onFailure: (line: string) => void): string | null {
	// per INVOCATION, not per run: a directory per call is how the tree
	// grew 400,000 of them once.
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "compose-"));
	const file = join(dir, "message.md"); // .md so the editor lights it up
	try {
		writeFileSync(file, text, "utf8");
		const r = spawnSync(bin, [file], { stdio: "inherit", shell: false });
		if (r.error !== undefined || (r.status !== null && r.status !== 0)) {
			onFailure(`[ctrl+g] ${bin} exited ${r.status ?? "abnormally"} — the composer is unchanged`);
			return null;
		}
		return readFileSync(file, "utf8").replace(/\n+$/, "");
	} catch (err) {
		onFailure(`[ctrl+g] ${err instanceof Error ? err.message : String(err)} — the composer is unchanged`);
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
