/**
 * The session log's sync on the thread pool (owner, 2026-11-25), state 7: a kill -9 writer. Every append the writer saw resolve is in the
 * file. This proves process-death safety only; power loss is not provable here. (A child process: the PTY pool; the rest of the states are
 * store-async-fsync.test.ts, in the unit pool.)
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/store.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "kiso-async-fsync-kill-"));

describe("kill -9: every append the writer saw resolve is in the file (process-death safety; power loss is not provable here)", () => {
	it("a writer printing each seq after its append resolved, SIGKILLed mid-stream, leaves every printed seq on disk", async () => {
		const root = dir();
		const writer = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const store = new SessionStore(${JSON.stringify(root)});
for (let i = 0; ; i++) {
	await store.append("s", "r", { seq: i, type: "stop", reason: "end_turn" });
	process.stdout.write(i + "\\n");
}
`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", writer], { stdio: ["ignore", "pipe", "ignore"] });
		const acked: number[] = [];
		let buf = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) acked.push(Number(l));
			if (acked.length >= 25 && !child.killed) child.kill("SIGKILL");
		});
		const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, sig) => resolve(sig)));
		expect(signal).toBe("SIGKILL");
		const onDisk = new Set(new SessionStore(root).load("s").map((r) => r.event.seq));
		expect(acked.length).toBeGreaterThanOrEqual(25);
		for (const seq of acked) expect(onDisk.has(seq)).toBe(true);
	}, 30_000);
});
