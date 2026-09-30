/**
 * The process module — how a command starts, how a process tree dies, and a
 * process's start time. The shell tool and the task runner both stand on
 * it (ADR-0058; the Windows line adds its win32 branches here).
 *
 * The shell tool's own tree-kill behaviour stays pinned where it always was
 * (hardening.test.ts); these cases call the module directly.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killTree, processStartTime, startCommand } from "../src/process.js";

const ws = () => mkdtempSync(join(tmpdir(), "kiso-process-"));

/** Live processes whose command line carries `marker` (never this test's own `ps`). */
function liveWith(marker: string): number {
	try {
		return execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
			.split("\n")
			.filter((l) => l.includes(marker) && !l.includes("ps -axo")).length;
	} catch {
		return 0;
	}
}

async function until(ok: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("startCommand", () => {
	it("runs the command through the shell in its own process group", async () => {
		const child = startCommand("sleep 30", { cwd: ws(), env: process.env });
		await until(() => child.pid !== undefined);
		const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
		expect(pgid).toBe(child.pid);
		expect(await killTree(child)).toEqual({ unconfirmed: [] });
	});
});

describe("killTree", () => {
	it("takes down a setsid()-escaped grandchild and confirms it", async () => {
		const marker = `sleep 8131.${Math.floor(Math.random() * 1e6)}`;
		const child = startCommand(`python3 -c "import os; os.setsid(); os.system('${marker}')" & wait`, { cwd: ws(), env: process.env });
		await until(() => liveWith(marker) > 0);
		expect(await killTree(child)).toEqual({ unconfirmed: [] });
		expect(liveWith(marker)).toBe(0);
	}, 15_000);

	it("graceMs: a child that traps TERM gets to clean up first", async () => {
		const dir = ws();
		const marker = join(dir, "cleaned");
		const child = startCommand(`trap 'echo bye > ${marker}; exit 0' TERM; echo up; sleep 30 & wait`, { cwd: dir, env: process.env });
		let out = "";
		child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
		await until(() => out.includes("up"));
		expect(await killTree(child, { graceMs: 3_000 })).toEqual({ unconfirmed: [] });
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8").trim()).toBe("bye");
	}, 15_000);

	it("graceMs: a tree that ignores TERM is still killed once the grace is over", async () => {
		const marker = `sleep 8132.${Math.floor(Math.random() * 1e6)}`;
		const child = startCommand(`trap '' TERM; ${marker} & wait`, { cwd: ws(), env: process.env });
		await until(() => liveWith(marker) > 0);
		const t0 = Date.now();
		expect(await killTree(child, { graceMs: 600 })).toEqual({ unconfirmed: [] });
		expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
		expect(liveWith(marker)).toBe(0);
	}, 15_000);
});

describe("processStartTime", () => {
	it("this process is running, with a start time", () => {
		const id = processStartTime(process.pid);
		expect(id.kind).toBe("running");
		expect(id.kind === "running" && id.startedAt.length > 0).toBe(true);
	});

	it("a reaped process is gone", async () => {
		const child = spawn("true");
		await new Promise((r) => child.on("close", r));
		expect(processStartTime(child.pid!)).toEqual({ kind: "gone" });
	});

	it("no way to ask is unknown — never gone", () => {
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(processStartTime(process.pid)).toEqual({ kind: "unknown" });
		} finally {
			process.env.PATH = path;
		}
	});
});
