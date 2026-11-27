/**
 * ADR-0064 A2 — a lease opening killed after each durable step (`opened`,
 * the bootstrap, `attached`) reconciles to the table's decision (A2 spec
 * § 5.3). A real SIGKILL of a child writer, so this file runs in the pty pool.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { describe, expect, it } from "vitest";
import { FileLogBackend } from "../src/file-log.js";
import { reconcileLease } from "../src/lease.js";
import { WorkLedger } from "../src/ledger.js";

const DIST = JSON.stringify(new URL("../dist/index.js", import.meta.url).href);
const RUNTIME = JSON.stringify(new URL("../../runtime/dist/index.js", import.meta.url).href);

/** Kill the child right after its `step`-th durable write of the opening: 1 opened, 2 the bootstrap, 3 attached. */
async function killedAfter(step: 1 | 2 | 3) {
	const root = mkdtempSync(join(tmpdir(), "kiso-lease-kill-"));
	const script = `
import { FileLogBackend, WorkLedger } from ${DIST};
import { SessionStore } from ${RUNTIME};
const backend = new FileLogBackend(${JSON.stringify(join(root, "work"))});
const store = new SessionStore(${JSON.stringify(join(root, "sessions"))});
const w = await WorkLedger.create(backend, { actorId: "act", objective: "ship", workId: "w1" });
let writes = 0;
const after = () => { if (++writes === ${step}) process.kill(process.pid, "SIGKILL"); };
const log = w.log;
const append = log.append.bind(log);
log.append = async (r, e) => { const n = await append(r, e); after(); return n; };
const storeAppend = store.append.bind(store);
store.append = async (...a) => { await storeAppend(...a); after(); };
await w.openLease({ store, sessionId: "s1", sources: [{ kind: "work-state" }], leaseId: "L1" });
process.exit(0);
`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
	const signal = await new Promise<NodeJS.Signals | null>((done) => child.on("exit", (_c, sig) => done(sig)));
	expect(signal).toBe("SIGKILL");
	const w = await WorkLedger.open(new FileLogBackend(join(root, "work")), "act", "w1");
	const store = new SessionStore(join(root, "sessions"));
	const sessionEvents = store.load("s1").map((r) => r.event);
	return { w, store, decision: reconcileLease({ commitment: w.view().commitment, sessionEvents, liveOwner: false, recoverableRun: false }) };
}

describe("a lease opening killed at each step", () => {
	it("after `opened`: retry the bootstrap", async () => {
		const { w, decision } = await killedAfter(1);
		expect(decision).toEqual({ decision: "retry-bootstrap" });
		await w.close();
	}, 30_000);

	it("after the bootstrap: attach the block that landed, and the lease is whole", async () => {
		const { w, store, decision } = await killedAfter(2);
		expect(decision.decision).toBe("attach");
		const projection = (store.load("s1")[0]!.event as { projection: string }).projection;
		await w.attachFoundBootstrap("L1", projection);
		expect(w.view().commitment.lease?.state).toBe("attached");
		await w.close();
	}, 30_000);

	it("after `attached`: settled, so release the stale lease", async () => {
		const { w, decision } = await killedAfter(3);
		expect(decision).toEqual({ decision: "release-stale" });
		await w.close();
	}, 30_000);
});
