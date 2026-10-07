/**
 * Graphite R3d — the name the person gave a session (`/name`): the
 * sidecar's third tenant, beside `profile` and `summary`. Session
 * metadata, never an event; the lists and the title read it, the title
 * derived from the first real line is the fallback.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@vincemakes/kiso-core";
import { SessionStore } from "../src/index.js";
import { buildProfile, profilePath, readProfile, readSessionName, readSummary, writeProfile, writeSessionName, writeSummary } from "../src/profile.js";
import { listSessionSidecars, type SessionSummary } from "../src/session-summary.js";

const dir = () => mkdtempSync(join(tmpdir(), "kiso-name-"));
const SUMMARY: SessionSummary = { title: "t", turns: 1, updatedAt: 5, state: "completed", uncertain: 0, asks: 0, workspaceUnknown: false, source: "run" };

async function logOf(root: string, id: string, first: string): Promise<void> {
	const store = new SessionStore(root);
	await store.append(id, "r1", { seq: 0, type: "user_input", content: first } as never);
	await store.append(id, "r1", { seq: 1, type: "stop", reason: "end_turn" } as never);
	store.closeAll();
}

describe("the name tenant", () => {
	it("round-trips, clears, and reads null when there is none", () => {
		const root = dir();
		expect(readSessionName(root, "s")).toBeNull();
		writeSessionName(root, "s", "retry work");
		expect(readSessionName(root, "s")).toBe("retry work");
		writeSessionName(root, "s", null);
		expect(readSessionName(root, "s")).toBeNull();
		expect(JSON.parse(readFileSync(profilePath(root, "s"), "utf8"))).not.toHaveProperty("name");
	});

	it("carries the profile and the summary through byte for byte, and they carry it", () => {
		const root = dir();
		writeProfile(root, "s", buildProfile({ revision: 1, modelId: "m", provider: null, registry: new ToolRegistry(), workspace: "/w" }));
		writeSummary(root, "s", SUMMARY);
		const before = JSON.parse(readFileSync(profilePath(root, "s"), "utf8")) as Record<string, unknown>;
		writeSessionName(root, "s", "named");
		const after = JSON.parse(readFileSync(profilePath(root, "s"), "utf8")) as Record<string, unknown>;
		expect(after.profile).toEqual(before.profile);
		expect(after.summary).toEqual(before.summary);
		writeProfile(root, "s", buildProfile({ revision: 2, modelId: "m2", provider: null, registry: new ToolRegistry(), workspace: "/w" }));
		writeSummary(root, "s", { ...SUMMARY, turns: 2 });
		expect(readSessionName(root, "s")).toBe("named");
		expect(readSummary(root, "s")?.turns).toBe(2);
	});

	it("a sidecar that holds only a name has no profile — absent, never corrupt (corrupt would block the session)", () => {
		const root = dir();
		writeSessionName(root, "s", "only a name");
		expect(readProfile(root, "s").kind).toBe("absent");
	});

	it("the store's list and the sidecar listing carry it; the derived title is the fallback", async () => {
		const root = dir();
		await logOf(root, "a", "fix the resize repaint");
		await logOf(root, "b", "write the release notes");
		writeSessionName(root, "b", "0.45 notes");
		const store = new SessionStore(root);
		const titles = Object.fromEntries(store.list().map((m) => [m.id, m.title]));
		expect(titles).toEqual({ a: "fix the resize repaint", b: "0.45 notes" });
		store.closeAll();
		const names = Object.fromEntries(listSessionSidecars(root).map((l) => [l.id, l.name]));
		expect(names).toEqual({ a: null, b: "0.45 notes" });
	});
});
