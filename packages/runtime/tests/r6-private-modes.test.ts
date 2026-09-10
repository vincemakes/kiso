/**
 * R6 — a session log and the history are PRIVATE by default.
 *
 * `auth.json` has been 0600 in a 0700 home since the credential store
 * shipped. The session logs never were: under the common umask 022 the
 * store's directories came out 0755 and the logs 0644, so every session's
 * full transcript — prompts, tool inputs, file contents the model read —
 * was world-readable on a shared machine. The history file the same.
 *
 * Existing files are NOT migrated: changing modes under someone's feet is
 * its own surprise, and a deliberate 0644 is a choice kiso should not
 * silently reverse. New homes are private; an old one stays as its owner
 * left it.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

const modeOf = (p: string): string => (statSync(p).mode & 0o777).toString(8);

let saved: number;
beforeEach(() => {
	saved = process.umask(0o022); // the common default, and the one that exposed this
});
afterEach(() => {
	process.umask(saved);
});

describe("R6 — private modes on a fresh home", () => {
	it("an EXISTING log is not migrated — its mode is its owner's choice", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-r6-keep-")), "home", "sessions");
		const store = new SessionStore(root);
		await store.append("s1", "r1", { seq: 0, type: "user_input", content: "first" } as never);
		store.closeAll();
		const { chmodSync } = await import("node:fs");
		chmodSync(join(root, "s1.jsonl"), 0o644); // the owner widens it deliberately
		const again = new SessionStore(root);
		await again.append("s1", "r2", { seq: 1, type: "user_input", content: "second" } as never);
		again.closeAll();
		expect(modeOf(join(root, "s1.jsonl")), "kiso does not reverse a deliberate choice").toBe("644");
	});

	it("the sessions directory is 0700 and a session log is 0600", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-r6-")), "home", "sessions");
		const store = new SessionStore(root);
		await store.append("s1", "r1", { seq: 0, type: "user_input", content: "private words" } as never);
		store.closeAll();
		expect(modeOf(root), "the directory does not list to the world").toBe("700");
		expect(modeOf(join(root, "s1.jsonl")), "nor does the transcript read to it").toBe("600");
	});
});
