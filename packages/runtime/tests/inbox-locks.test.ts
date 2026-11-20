import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ChainBudget } from "../src/chains.js";
import { takeOverStale } from "../src/dir-lock.js";
import { inboxDir, readInbox, releaseMessage, writeMessage, type PeerMessage } from "../src/inbox.js";

// finding G3: the inbox's lock take-over, releasing a held message, and the chain budget's read-modify-write
const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ messageId: id, from: "k/s", fromTitle: "S", text: id, files: [], rootId: "k/s#0", at: 1, ...extra });

describe("the directory lock's take-over (finding G3)", () => {
	it("a live lock is never taken over; a stale one is, once", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-lk-"));
		const lock = join(dir, ".lock");
		mkdirSync(lock);
		expect(takeOverStale(lock), "fresh: another holder's").toBe(false);
		expect(existsSync(lock)).toBe(true);
		const old = (Date.now() - 60_000) / 1000;
		utimesSync(lock, old, old);
		expect(takeOverStale(lock), "stale: its holder died").toBe(true);
		expect(existsSync(lock)).toBe(false);
		expect(takeOverStale(lock), "already gone").toBe(true);
	});

	it("a message is written past a lock its dead holder left behind", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-lk-"));
		const lock = join(inboxDir(root, "r"), ".lock");
		mkdirSync(lock, { recursive: true });
		const old = (Date.now() - 60_000) / 1000;
		utimesSync(lock, old, old);
		expect(await writeMessage(root, "r", msg("m1"))).toBe("written");
		expect(existsSync(lock), "released after").toBe(false);
	});
});

describe("releaseMessage (finding G3)", () => {
	it("a session with no inbox: nothing to release, not an error", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-rl-"));
		await expect(releaseMessage(root, "never-messaged", "m1")).resolves.toBe(false);
	});

	it("a held message is written again without the hold, whole", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-rl-"));
		await writeMessage(root, "r", msg("m1", { held: true }));
		expect(await releaseMessage(root, "r", "m1")).toBe(true);
		const [m] = readInbox(root, "r");
		expect(m?.held).toBeUndefined();
		expect(JSON.parse(readFileSync(join(inboxDir(root, "r"), "m1.json"), "utf8")).text).toBe("m1");
	});
});

describe("ChainBudget across processes (finding G3)", () => {
	it("four processes taking at once spend exactly the budget, never more", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-cbp-"));
		const dist = resolve(__dirname, "../dist/chains.js");
		const env = { ...process.env };
		delete env["NODE_TEST_CONTEXT"];
		// every process waits for the same moment, then takes as fast as it can
		const go = Date.now() + 1500;
		const script = `import { ChainBudget } from ${JSON.stringify(dist)}; const b = new ChainBudget(${JSON.stringify(dir)}, 120); while (Date.now() < ${go}); let n = 0; for (let i = 0; i < 60; i++) if (b.take("k/a#0")) n++; console.log(n);`;
		const run = (): Promise<{ status: number | null; out: string; err: string }> =>
			new Promise((done) => {
				const k = spawn(process.execPath, ["--input-type=module", "-e", script], { env });
				let out = "";
				let err = "";
				k.stdout.on("data", (d: Buffer) => (out += d.toString()));
				k.stderr.on("data", (d: Buffer) => (err += d.toString()));
				k.on("close", (status) => done({ status, out, err }));
			});
		const kids = await Promise.all([run(), run(), run(), run()]);
		for (const k of kids) expect(k.status, k.err).toBe(0);
		const taken = kids.reduce((s, k) => s + Number(k.out.trim()), 0);
		expect(taken, "never more yeses than the budget").toBe(120);
		expect(new ChainBudget(dir, 120).spent("k/a#0"), "every yes was counted").toBe(120);
	}, 60_000);
});
