/**
 * The per-run TMPDIR root (the 2026-09-03 TMPDIR finding).
 *
 * Every CLI e2e builds an isolated fake home under os.tmpdir(), every
 * PTY scenario writes its driver there, every faux trajectory gets a
 * directory of its own: 155 files, 416 mkdtemp sites, 20 files with any
 * rm at all. Eighteen days of runs on one machine left 411,794 `kiso-*`
 * entries (about 1,000 per full run, about 17,000 per busy day) in the
 * user's TMPDIR. A directory that size is un-enumerable for everything
 * that lists it: launch services, the indexer, and the OS's own temp
 * reaper, which deletes stale FILES but never the directories, so the
 * count only ever grew.
 *
 * The fix sits one level above the call sites. This global setup makes
 * ONE root per vitest invocation under the real tmpdir and points TMPDIR
 * at it before any worker exists. Every worker's os.tmpdir(), every
 * mkdtemp in every test, and every child spawned with `...process.env`
 * (the isolation helper, the PTY driver, the built CLI and whatever it
 * writes for itself) land inside that root; teardown removes the root.
 * Verified for both pools (forks and threads): the env set here reaches
 * the workers, and a child inherits it.
 *
 * Why not afterEach at the call sites: it would touch 155 test files,
 * and it cannot reach a directory that a CHILD process makes for itself.
 *
 * Bounded residue, stated: a run killed with SIGKILL leaves its one root
 * (one entry, not thousands); the next invocation reaps any root older
 * than STALE_MS. A child handed an env WITHOUT TMPDIR falls back to /tmp:
 * no test does that today (every spawn spreads process.env); a new one
 * would leak there, not here. Scripts outside vitest (smoke, bench,
 * pack-check) still write to the real tmpdir: 1,183 entries in the same
 * eighteen days, not this finding's scale.
 *
 * tests/tmpdir-root.test.ts (unit pool) and tests/tmpdir-root-pty.test.ts
 * (pty pool) assert that the redirect is live in each pool.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The root's name prefix in the real tmpdir; the two invariant tests
 *  recognize the run's root by it. */
export const ROOT_PREFIX = "kiso-vitest-";

/** A root older than this is never a live run's (a full pool is minutes). */
const STALE_MS = 6 * 60 * 60 * 1000;

/** Best-effort: remove roots an earlier invocation could not tear down
 *  (SIGKILL, a power cut). Only our own prefix, only directories, only
 *  stale ones; a live run's root gains an entry every few seconds. */
function reapStaleRoots(host: string): void {
	let names: string[];
	try {
		names = readdirSync(host);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		if (!name.startsWith(ROOT_PREFIX)) continue;
		const p = join(host, name);
		try {
			const st = statSync(p);
			if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue;
			rmSync(p, { recursive: true, force: true });
		} catch {
			// best-effort: a root that cannot be read or removed is left alone
		}
	}
}

export default function setup(): () => void {
	const host = tmpdir();
	reapStaleRoots(host);
	const root = mkdtempSync(join(host, ROOT_PREFIX));
	process.env.TMPDIR = root;
	return () => {
		rmSync(root, { recursive: true, force: true });
	};
}
