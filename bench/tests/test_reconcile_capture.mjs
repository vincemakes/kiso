/** The reconciler's own gates, on synthetic captures. No network, no money. */
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCapture, reconcile, effortOf } from "../reconcile-capture.mjs";

let failed = 0;
const note = (ok, what) => { console.log(`  ${ok ? "ok  " : "RED "} ${what}`); if (!ok) failed = 1; };

function capture(bodies) {
	const d = mkdtempSync(join(tmpdir(), "recon-"));
	bodies.forEach((b, i) => writeFileSync(join(d, `req-${String(i + 1).padStart(5, "0")}.json`),
		JSON.stringify({ seq: i + 1, path: "/v1/chat/completions", bodyBytes: JSON.stringify(b).length, bodySha256: "x", body: b })));
	return d;
}
const call = (n, extra = {}) => ({ model: "deepseek-flash", messages: Array.from({ length: n }, () => ({ role: "user", content: "x" })), ...extra });

// effort, under every spelling a vendor uses
note(effortOf({ reasoning_effort: "high" }) === "high", "effort read from reasoning_effort");
note(effortOf({ thinking: { type: "high" } }) === "high", "effort read from a thinking object");
note(effortOf({ reasoning: { effort: "high" } }) === "high", "effort read from a reasoning object");
note(effortOf({ model: "m" }) === null, "a body with no effort field reads null, not a default");

// `none`: the provider's default, verified as ABSENCE (2026-10-07, the
// Command Code route, where the effort switch cannot bind)
const bare = capture([call(1), call(2)]);
let rn = reconcile(readCapture(bare), { requests: 2, model: "deepseek-flash", effort: "none" });
note(rn.ok && rn.effortObserved === "none", "effort none: bodies with no effort field reconcile, observed as none");
const leaked = capture([call(1), call(2, { reasoning_effort: "medium" })]);
rn = reconcile(readCapture(leaked), { requests: 2, model: "deepseek-flash", effort: "none" });
note(!rn.ok && rn.problems.some((p) => p.includes("1 of 2 bodies carry an effort field")), "effort none: one body carrying an effort fails, and says how many");
note(rn.effortObserved !== "none", "effort none: a leaked effort is never reported as none");

const good = capture([call(1, { reasoning_effort: "high" }), call(3, { reasoning_effort: "high" })]);
let r = reconcile(readCapture(good), { requests: 2, model: "deepseek-flash", effort: "high" });
note(r.ok, "a capture that agrees reconciles");
note(r.effortObserved === "high", "the observed effort is reported back");

r = reconcile(readCapture(good), { requests: 3, model: "deepseek-flash", effort: "high" });
note(!r.ok && r.problems[0].includes("the leg recorded 3"), "a MISSING body fails the count check");

r = reconcile(readCapture(good), { requests: 2, model: "some-other-model", effort: "high" });
note(!r.ok && r.problems[0].includes("the leg declares"), "a body naming another model fails");

const noEffort = capture([call(1), call(2)]);
r = reconcile(readCapture(noEffort), { requests: 2, model: "deepseek-flash", effort: "high" });
note(!r.ok && r.problems[0].includes("no effort field"), "bodies with no effort field fail when one is declared");

const wrongEffort = capture([call(1, { reasoning_effort: "low" })]);
r = reconcile(readCapture(wrongEffort), { requests: 1, model: "deepseek-flash", effort: "high" });
note(!r.ok && r.problems[0].includes("effort"), "a body carrying the WRONG effort fails");

// a shrink is reported, never gated
const shrank = capture([call(5, { reasoning_effort: "high" }), call(1, { reasoning_effort: "high" })]);
r = reconcile(readCapture(shrank), { requests: 2, model: "deepseek-flash", effort: "high" });
note(r.ok && r.shrinks.length === 1, "a body that SHRANK is reported and does not fail — compaction is legitimate");

// non-call traffic is not counted as a request
const mixed = mkdtempSync(join(tmpdir(), "recon-"));
writeFileSync(join(mixed, "req-00001.json"), JSON.stringify({ seq: 1, path: "/v1/models", bodyBytes: 2, body: {} }));
writeFileSync(join(mixed, "req-00002.json"), JSON.stringify({ seq: 2, path: "/v1/chat/completions", bodyBytes: 40, body: call(1, { reasoning_effort: "high" }) }));
r = reconcile(readCapture(mixed), { requests: 1, model: "deepseek-flash", effort: "high" });
note(r.ok && r.nonCallRecords === 1, "traffic that is not a model call is excluded and counted separately");

note(reconcile(null, {}).ok === false, "a missing capture directory is not a pass");

// --- the adapter's OWN dump: the other file shape, and the ordering trap
function dumpCapture(entries) {
	const d = mkdtempSync(join(tmpdir(), "dump-"));
	for (const { pid, seq, body } of entries) writeFileSync(join(d, `req-${pid}-${seq}.json`), JSON.stringify(body));
	return d;
}

const dump = dumpCapture([
	{ pid: 9, seq: 1, body: call(1, { reasoning_effort: "high" }) },
	{ pid: 9, seq: 2, body: call(2, { reasoning_effort: "high" }) },
	{ pid: 10, seq: 1, body: call(3, { reasoning_effort: "high" }) },
]);
r = reconcile(readCapture(dump), { requests: 3, model: "deepseek-flash", effort: "high" });
note(r.ok, "a directory of adapter DUMPS reconciles, with no proxy involved");

// THE ORDERING TRAP. The dump counter is per PROCESS and a leg runs
// several, so the names sort wrong twice over: lexicographically
// "req-10-1" precedes "req-9-1" (process order inverted) and "req-9-10"
// precedes "req-9-2" (request order inverted). Both must be by NUMBER.
const ordering = dumpCapture([
	{ pid: 9, seq: 2, body: call(2, { reasoning_effort: "high" }) },
	{ pid: 9, seq: 10, body: call(10, { reasoning_effort: "high" }) },
	{ pid: 10, seq: 1, body: call(1, { reasoning_effort: "high" }) },
]);
const ord = readCapture(ordering).map((x) => `${x.pid}-${x.seq}`);
note(JSON.stringify(ord) === JSON.stringify(["9-2", "9-10", "10-1"]),
	`dumps order by pid then seq, not as strings (got ${JSON.stringify(ord)})`);

// AND THE PID ORDER MUST LOSE TO THE WRITE ORDER. A pid does not rise
// with start time — the OS reuses and wraps them — so a later process can
// carry a SMALLER pid. Written in the true order with the pids inverted,
// the capture must still read in the order it was written.
const wrapped = mkdtempSync(join(tmpdir(), "wrap-"));
const later = { pid: 7, seq: 1, body: call(9, { reasoning_effort: "high" }) };   // ran second, smaller pid
const first = { pid: 9000, seq: 1, body: call(1, { reasoning_effort: "high" }) }; // ran first, larger pid
writeFileSync(join(wrapped, `req-${first.pid}-1.json`), JSON.stringify(first.body));
const t0 = Date.now();
utimesSync(join(wrapped, `req-${first.pid}-1.json`), t0 / 1000, t0 / 1000);
writeFileSync(join(wrapped, `req-${later.pid}-1.json`), JSON.stringify(later.body));
utimesSync(join(wrapped, `req-${later.pid}-1.json`), (t0 + 5000) / 1000, (t0 + 5000) / 1000);
const wrapOrder = readCapture(wrapped).map((x) => x.pid);
note(JSON.stringify(wrapOrder) === JSON.stringify([9000, 7]),
	`a wrapped pid loses to the write order (got ${JSON.stringify(wrapOrder)})`);

// and the shapes coexist: a leg may hold both arms' captures side by side
const bothShapes = mkdtempSync(join(tmpdir(), "both-"));
writeFileSync(join(bothShapes, "req-00001.json"), JSON.stringify({ seq: 1, path: "/v1/chat/completions", bodyBytes: 10, body: call(1, { reasoning_effort: "high" }) }));
writeFileSync(join(bothShapes, "req-4242-1.json"), JSON.stringify(call(2, { reasoning_effort: "high" })));
r = reconcile(readCapture(bothShapes), { requests: 2, model: "deepseek-flash", effort: "high" });
note(r.ok && r.checked === 2, "a proxy record and an adapter dump read through ONE set of gates");

console.log(`[reconcile-capture] ${failed ? "RED" : "OK"}`);
process.exit(failed);
