// The history reads each folder in one worker that lives across reads; a read's listeners must go with its answer. Before the
// fix every read left an `error` listener on the worker: past ten folders Node warned (MaxListenersExceededWarning, seen on the
// owner's host 2026-11-03) and a worker error would have run every stale listener at once.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimProjectDir, projectDirFor } from "@vincemakes/kiso-code/config";
import { History } from "../../dist/main/history.js";
import { scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("history-listeners");
const home = scratch("hl-home");
const warnings = [];
process.on("warning", (w) => warnings.push(w.name));
for (let i = 0; i < 14; i++) {
	const ws = scratch(`hl-ws${i}`);
	const dir = projectDirFor(home, ws);
	mkdirSync(dir, { recursive: true });
	claimProjectDir(dir, ws);
	writeFileSync(join(dir, `w${i}.jsonl`), `${JSON.stringify({ runId: "r", ts: Date.now(), event: { type: "user_input", content: `task ${i}`, seq: 0 } })}\n`);
}
const history = new History(home, async () => "idle");
const current = { key: "none", dir: join(home, "none") };
const read = await waitUntil(async () => {
	const reply = await history.snapshot(current);
	return !reply.scanning && reply.works.length === 14;
}, 30_000);
await new Promise((r) => setImmediate(r));
check(read && !warnings.includes("MaxListenersExceededWarning"), `fourteen folders read through one worker leave no listeners behind (rows read: ${read}; warnings: ${warnings.join() || "none"})`);
history.close();
verdict();
