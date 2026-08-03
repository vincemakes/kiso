/**
 * End-to-end: the BUILT CLI (plain node, no tsx) holds a durable session
 * across process boundaries — chat in one process, resume in another,
 * sessions listing, and the JSONL shows both runs. Requires the CLI build
 * (npm run check builds before testing).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@kiso/runtime";
import { readdirSync } from "node:fs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

function runCli(args: string[], input: string, env: Record<string, string>) {
	return spawnSync("node", [CLI, ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
}

describe("kiso CLI (built artifact, faux mode)", () => {
	it("chat → resume in a new process → sessions listing → durable two-run history", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		const id = "e2e";

		// Process 1: interactive chat, one turn, exit.
		const first = runCli(["chat", id], "look around\nexit\n", { KISO_HOME: home });
		expect(first.status, first.stderr).toBe(0);
		expect(first.stdout).toContain(`session ${id}`);
		expect(first.stdout).toContain("faux model");

		// Process 2: resume the same session from disk — a NEW process sees
		// the first run's history and completes another turn.
		const second = runCli(["resume", id, "continue"], "", { KISO_HOME: home });
		expect(second.status, second.stderr).toBe(0);
		expect(second.stdout).toContain("done"); // the honest terminal

		// Process 3: sessions lists the durable session.
		const sessions = runCli(["sessions"], "", { KISO_HOME: home });
		expect(sessions.status).toBe(0);
		expect(sessions.stdout).toContain(id);

		// The JSONL carries both runs — the cross-process trajectory.
		const store = new SessionStore(join(home, "sessions"));
		const records = store.load(id);
		expect(records.length).toBeGreaterThan(0);
		expect(new Set(records.map((r) => r.runId)).size).toBe(2);
		// seq is contiguous across the process boundary.
		const seqs = records.map((r) => r.event.seq);
		expect(seqs).toEqual([...seqs.keys()]);
		// E 组: no writer lock is left behind after the CLI exits.
				const leftovers = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".lock"));
		expect(leftovers).toEqual([]);
	});

	it("faux chat supports at least two consecutive user turns in ONE process (F 组)", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		const result = runCli(["chat", "twoturns"], "first question\nsecond question\nexit\n", { KISO_HOME: home });
		expect(result.status, result.stderr).toBe(0);
		// Two turns rendered, two honest terminals ("done").
		const doneCount = (result.stdout.match(/done/g) ?? []).length;
		expect(doneCount).toBe(2);
	});

	it("help exits cleanly", () => {
		const result = runCli(["help"], "", {});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("kiso chat");
	});
});
