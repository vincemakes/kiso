import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEmptySessions, moveToTrash } from "../src/empty-sessions.js";

/**
 * DC-60 — `kiso sessions --prune-empty`: the sessions an older kiso left
 * with a sidecar and no log are listed, and with --yes MOVED to the Trash,
 * never deleted. Every path here is a mkdtemp directory: a test of a
 * command that moves files never names the real home.
 */

/** A project folder with one real session, two empty ones (one with a
 *  trace, one with a stale lock) and one empty session a live process holds. */
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-dc60-prune-"));
	mkdirSync(join(dir, "traces"));
	// a session that ran: log + sidecar + trace
	writeFileSync(join(dir, "real.jsonl"), "{}\n");
	writeFileSync(join(dir, "real.meta.json"), "{}");
	writeFileSync(join(dir, "traces", "real.jsonl"), "{}\n");
	// empty: sidecar + trace (the observed shape)
	writeFileSync(join(dir, "ghost-a.meta.json"), "{}");
	writeFileSync(join(dir, "traces", "ghost-a.jsonl"), "{}\n");
	// empty: sidecar + a stale lock (its pid is dead)
	writeFileSync(join(dir, "ghost-b.meta.json"), "{}");
	writeFileSync(join(dir, "ghost-b.lock"), JSON.stringify({ pid: 999_999_991, token: "t" }));
	// empty but IN USE: a live lock
	writeFileSync(join(dir, "live.meta.json"), "{}");
	writeFileSync(join(dir, "live.lock"), JSON.stringify({ pid: 424_242, token: "t" }));
	return dir;
}

const alive = (pid: number): boolean => pid === 424_242;

describe("DC-60 — findEmptySessions", () => {
	it("lists every sidecar without a log, with the files that name it; a session in use is counted, not listed", () => {
		const dir = folder();
		const { empty, inUse } = findEmptySessions([dir], alive);
		expect(empty.map((s) => s.id).sort()).toEqual(["ghost-a", "ghost-b"]);
		expect([...empty.find((s) => s.id === "ghost-a")!.files].sort()).toEqual(["ghost-a.meta.json", join("traces", "ghost-a.jsonl")].sort());
		expect([...empty.find((s) => s.id === "ghost-b")!.files].sort()).toEqual(["ghost-b.lock", "ghost-b.meta.json"]);
		expect(inUse).toBe(1);
	});

	it("reads only — the scan moves nothing, and a missing folder is skipped", () => {
		const dir = folder();
		const before = readdirSync(dir).sort();
		findEmptySessions([dir, join(dir, "no-such-folder")], alive);
		expect(readdirSync(dir).sort()).toEqual(before);
	});
});

describe("DC-60 — moveToTrash", () => {
	it("moves the empty sessions into one new folder under the Trash, keeping the project folder's name; the real session stays", () => {
		const dir = folder();
		const trash = mkdtempSync(join(tmpdir(), "kiso-dc60-trash-"));
		const { empty } = findEmptySessions([dir], alive);
		const target = moveToTrash(empty, trash, new Date("2026-09-23T03:00:00.000Z"));
		expect(target).toBe(join(trash, "kiso-empty-sessions-2026-09-23T03-00-00-000Z"));
		const project = join(target, basename(dir));
		expect(readdirSync(project).sort()).toEqual(["ghost-a.meta.json", "ghost-b.lock", "ghost-b.meta.json", "traces"]);
		expect(readdirSync(join(project, "traces"))).toEqual(["ghost-a.jsonl"]);
		// gone from the folder; the session that ran and the one in use are untouched
		for (const f of ["ghost-a.meta.json", "ghost-b.meta.json", "ghost-b.lock", join("traces", "ghost-a.jsonl")]) expect(existsSync(join(dir, f))).toBe(false);
		for (const f of ["real.jsonl", "real.meta.json", join("traces", "real.jsonl"), "live.meta.json", "live.lock"]) expect(existsSync(join(dir, f))).toBe(true);
	});
});
