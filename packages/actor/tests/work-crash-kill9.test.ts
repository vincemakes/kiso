/**
 * ADR-0064 § 3 — uncertainty belongs to the crash window alone (ADR-0038):
 * a dispatch that is durable and then loses its process reads uncertain, and
 * the effect is never retried silently. A real SIGKILL of a child writer, so
 * this file runs in the pty pool (tests/pty-suite.json).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLogBackend } from "../src/file-log.js";
import { WorkLedger } from "../src/ledger.js";

describe("the crash window, across a real process kill", () => {
	it("a writer SIGKILLed after a durable dispatch leaves the effect uncertain and the work needs-human", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-actor-kill-"));
		const script = `
import { FileLogBackend, WorkLedger } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const w = await WorkLedger.create(new FileLogBackend(${JSON.stringify(root)}), { actorId: "act", objective: "o", workId: "w1" });
const id = await w.prepareEffect({ action: "deploy", label: "deploy", effectId: "fx" });
await w.dispatchEffect(id);
process.kill(process.pid, "SIGKILL");
`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
		const signal = await new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_c, sig) => done(sig)));
		expect(signal).toBe("SIGKILL");
		const w = await WorkLedger.open(new FileLogBackend(root), "act", "w1");
		expect(w.view().commitment.status).toBe("needs-human");
		expect(w.view().commitment.effects[0]?.status).toBe("uncertain");
		await expect(w.dispatchEffect("fx")).rejects.toThrow(/no silent retry/);
		await w.close();
	}, 30_000);
});
