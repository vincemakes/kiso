#!/usr/bin/env node
/** The cost-geometry extractor (protocol §4): first-request fresh / cacheRead
 *  and hit% PER SESSION START within a leg (every resume is a new session
 *  start, so F8's artifact class recurs at every restart), beside the leg's
 *  totals (cost-weighted = fresh + 0.1 × cacheRead + output — rd1's metrics.py
 *  population, never mixed across arms).
 *
 *  Acceptance (§4, free): the extractor must REPRODUCE the published F8
 *  per-cell table from the tracked clean-replay archives — an extractor that
 *  cannot re-derive the finding that motivated it is not proven.
 *
 *  usage: cost-geometry.mjs --leg <legDir>            (an LH-1 leg: agent-state/sessions/traces)
 *         cost-geometry.mjs --traces <dir> [--pi <dir>] (any kiso traces dir; a pi sessions dir)
 *         cost-geometry.mjs --rd1-clean [--check]     (the F8 table from bench/rd1/artifacts; --check pins it) */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const RD1_ARTIFACTS = join(repo, "bench", "rd1", "artifacts");

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const hit = (fresh, cached) => (fresh + cached > 0 ? cached / (fresh + cached) : null);
const pct = (h) => (h === null ? "—" : `${(h * 100).toFixed(1)}%`);
const readJsonl = (p) =>
	readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

/** kiso: one trace file per session. A SESSION START (a process start, the
 *  unit F8's artifact class recurs at) is marked by a `header` record (the
 *  first process), by a `crash` record (a resume after a kill or a lost
 *  terminal: "previous run left no run_end"), or by a request whose
 *  requestIndex returns to 0 after other requests (a resume after a clean
 *  exit). The first `request` after each mark is that start's first request. */
export function extractKisoTraces(tracesDir) {
	const starts = [];
	const totals = { requests: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	if (!existsSync(tracesDir)) return { arm: "kiso", starts, totals: finish(totals), hitAfterFirst: null };
	const hitsAfterFirst = [];
	for (const f of readdirSync(tracesDir).filter((n) => n.endsWith(".jsonl")).sort()) {
		const session = f.replace(/\.jsonl$/, "");
		let pending = null;
		let firstOfStart = true;
		const open = (why) => {
			pending = { session, start: starts.length + 1, startedBy: why, firstRequest: null, requests: 0 };
			starts.push(pending);
			firstOfStart = true;
		};
		for (const r of readJsonl(join(tracesDir, f))) {
			if (r.kind === "header") {
				open("header");
				continue;
			}
			if (r.kind === "crash") {
				open("crash");
				continue;
			}
			if (r.kind !== "request") continue;
			if (pending === null) open("first request (no header)");
			else if (r.requestIndex === 0 && pending.requests > 0) open("requestIndex reset");
			const u = { fresh: num(r.freshInput), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite), output: num(r.output) };
			totals.requests += 1;
			totals.fresh += u.fresh;
			totals.cacheRead += u.cacheRead;
			totals.cacheWrite += u.cacheWrite;
			totals.output += u.output;
			pending.requests += 1;
			if (firstOfStart) {
				pending.firstRequest = { ...u, hit: hit(u.fresh, u.cacheRead), systemPromptHash: r.systemPromptHash ?? null, toolSchemaHash: r.toolSchemaHash ?? null };
				firstOfStart = false;
			} else hitsAfterFirst.push(hit(u.fresh, u.cacheRead));
		}
	}
	const after = hitsAfterFirst.filter((h) => h !== null);
	return { arm: "kiso", starts, totals: finish(totals), hitAfterFirst: after.length ? after.reduce((a, b) => a + b, 0) / after.length : null };
}

/** pi: assistant messages with `usage` in pi-sessions/*.jsonl (rd1 metrics.py's
 *  read_pi); one file per session, the first assistant usage is the session's
 *  first request. */
export function extractPiSessions(sessionsDir) {
	const starts = [];
	const totals = { requests: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	if (!existsSync(sessionsDir)) return { arm: "pi", starts, totals: finish(totals), hitAfterFirst: null };
	const hitsAfterFirst = [];
	for (const f of readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl")).sort()) {
		const s = { session: f.replace(/\.jsonl$/, ""), start: starts.length + 1, firstRequest: null, requests: 0 };
		starts.push(s);
		for (const r of readJsonl(join(sessionsDir, f))) {
			const msg = r.message || {};
			if (msg.role !== "assistant" || !msg.usage) continue;
			const u = { fresh: num(msg.usage.input), cacheRead: num(msg.usage.cacheRead), cacheWrite: num(msg.usage.cacheWrite), output: num(msg.usage.output) };
			totals.requests += 1;
			totals.fresh += u.fresh;
			totals.cacheRead += u.cacheRead;
			totals.cacheWrite += u.cacheWrite;
			totals.output += u.output;
			s.requests += 1;
			if (s.firstRequest === null) s.firstRequest = { ...u, hit: hit(u.fresh, u.cacheRead) };
			else hitsAfterFirst.push(hit(u.fresh, u.cacheRead));
		}
	}
	const after = hitsAfterFirst.filter((h) => h !== null);
	return { arm: "pi", starts, totals: finish(totals), hitAfterFirst: after.length ? after.reduce((a, b) => a + b, 0) / after.length : null };
}

function finish(t) {
	return { ...t, costWeighted: t.fresh + 0.1 * t.cacheRead + t.output, hit: hit(t.fresh, t.cacheRead) };
}

const fmtStart = (s) => (s.firstRequest ? `${s.firstRequest.fresh} / ${s.firstRequest.cacheRead} (${pct(s.firstRequest.hit)})` : "no request");

function printLeg(label, g) {
	console.log(`[lh1:cost-geometry] ${label} arm=${g.arm} requests=${g.totals.requests} fresh=${g.totals.fresh} cacheRead=${g.totals.cacheRead} output=${g.totals.output} cost-weighted=${g.totals.costWeighted.toFixed(0)} hit=${pct(g.totals.hit)} hit-after-first=${pct(g.hitAfterFirst)}`);
	for (const s of g.starts) console.log(`  session start ${s.start} (${s.session}${s.startedBy ? `, ${s.startedBy}` : ""}): first request ${fmtStart(s)}; ${s.requests} requests`);
}

/** The F8 table from the tracked clean-replay archives, per cell, both arms. */
export function rd1CleanTable() {
	const tmp = mkdtempSync(join(tmpdir(), "lh1-f8-"));
	try {
		for (const arm of ["kiso", "pi"]) execFileSync("tar", ["-xzf", join(RD1_ARTIFACTS, `rd1b-clean-${arm}.tar.gz`), "-C", tmp]);
		const cellOrder = (a, b) => {
			const [ca, ra] = a.slice(1).split("-r").map(Number);
			const [cb, rb] = b.slice(1).split("-r").map(Number);
			return ra - rb || ca - cb;
		};
		const cells = readdirSync(join(tmp, "rd1b-clean-kiso")).filter((c) => /^c\d+-r\d+$/.test(c)).sort(cellOrder);
		const rows = [];
		for (const cell of cells) {
			const k = extractKisoTraces(join(tmp, "rd1b-clean-kiso", cell, "home", "sessions", "traces"));
			const p = extractPiSessions(join(tmp, "rd1b-clean-pi", cell, "pi-sessions"));
			rows.push({ cell, kiso: k.starts[0]?.firstRequest ?? null, pi: p.starts[0]?.firstRequest ?? null, kisoStarts: k.starts.length, piStarts: p.starts.length });
		}
		return rows;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** The pins: RD1B-Finding-008's published cells, verbatim. The c7 cells are
 *  the DECLARED I-STREAM exclusion (the proxy cut; pi non-proxyable) — the
 *  common-population rule (§6) leaves them out of every arm's table, and
 *  F8's "every later cell" is the 16 paired cells. They are printed, never
 *  scored: kiso's cut first request records zero usage, as the row shows. */
const F8 = {
	"c1-r1": { kiso: [66, 2304], pi: [71, 1664] },
	"c2-r1": { kiso: [58, 2304], pi: [1087, 640] },
	"c3-r1": { kiso: [58, 2304], pi: [1087, 640] },
	later: { kisoFresh: [58, 81], kisoCached: 2304, piCached: 640 },
	excluded: (cell) => cell.startsWith("c7-"),
};

function checkF8(rows) {
	const errs = [];
	for (const r of rows) {
		if (F8.excluded(r.cell)) continue;
		if (!r.kiso || !r.pi) {
			errs.push(`${r.cell}: missing a first request (kiso ${r.kiso ? "ok" : "none"}, pi ${r.pi ? "ok" : "none"})`);
			continue;
		}
		const pin = F8[r.cell];
		if (pin) {
			if (r.kiso.fresh !== pin.kiso[0] || r.kiso.cacheRead !== pin.kiso[1]) errs.push(`${r.cell} kiso ${r.kiso.fresh}/${r.kiso.cacheRead} ≠ F8's ${pin.kiso.join("/")}`);
			if (r.pi.fresh !== pin.pi[0] || r.pi.cacheRead !== pin.pi[1]) errs.push(`${r.cell} pi ${r.pi.fresh}/${r.pi.cacheRead} ≠ F8's ${pin.pi.join("/")}`);
		} else {
			if (r.kiso.fresh < F8.later.kisoFresh[0] || r.kiso.fresh > F8.later.kisoFresh[1] || r.kiso.cacheRead !== F8.later.kisoCached) errs.push(`${r.cell} kiso ${r.kiso.fresh}/${r.kiso.cacheRead} outside F8's "58–81 / 2,304"`);
			if (r.pi.cacheRead !== F8.later.piCached) errs.push(`${r.cell} pi cached ${r.pi.cacheRead} ≠ F8's 640`);
		}
	}
	return errs;
}

// entry guard by REAL path: on macOS /tmp is a symlink to /private/tmp, so a
// fresh copy under /tmp sees argv[1] and import.meta.url disagree by prefix
// (the gate's first run printed nothing and exited 0 for exactly that reason)
const isEntry = (() => {
	try {
		return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();
if (isEntry) {
	const args = process.argv.slice(2);
	const opt = (name) => {
		const i = args.indexOf(name);
		return i === -1 ? undefined : (args[i + 1] ?? true);
	};
	if (args.includes("--rd1-clean")) {
		const rows = rd1CleanTable();
		console.log("[lh1:cost-geometry] RD-1B clean replay, first request per cell (F8's table, re-derived from the tracked archives)");
		console.log("cell     | kiso fresh / cached (hit)     | pi fresh / cached (hit)");
		for (const r of rows) console.log(`${r.cell.padEnd(8)} | ${(r.kiso ? `${r.kiso.fresh} / ${r.kiso.cacheRead} (${pct(r.kiso.hit)})` : "none").padEnd(29)} | ${r.pi ? `${r.pi.fresh} / ${r.pi.cacheRead} (${pct(r.pi.hit)})` : "none"}${F8.excluded(r.cell) ? "   ← I-STREAM cell, declared exclusion (printed, not scored)" : ""}`);
		if (args.includes("--check")) {
			const errs = checkF8(rows);
			const scored = rows.filter((r) => !F8.excluded(r.cell)).length;
			console.log(errs.length ? `[lh1:cost-geometry] F8 NOT reproduced:\n  ${errs.join("\n  ")}` : `[lh1:cost-geometry] F8 reproduced — ${scored} paired cells (${rows.length - scored} I-STREAM cells excluded as declared): c1-r1/c2-r1/c3-r1 exact, the rest inside the published band`);
			process.exit(errs.length ? 1 : 0);
		}
	} else if (opt("--leg")) {
		const leg = opt("--leg");
		const g = extractKisoTraces(join(leg, "agent-state", "sessions", "traces"));
		printLeg(leg, g);
		writeFileSync(join(leg, "cost-geometry.json"), `${JSON.stringify(g, null, 1)}\n`);
	} else if (opt("--traces") || opt("--pi")) {
		if (opt("--traces")) printLeg(opt("--traces"), extractKisoTraces(opt("--traces")));
		if (opt("--pi")) printLeg(opt("--pi"), extractPiSessions(opt("--pi")));
	} else {
		console.error("usage: cost-geometry.mjs --leg <legDir> | --traces <dir> [--pi <dir>] | --rd1-clean [--check]");
		process.exit(2);
	}
}
