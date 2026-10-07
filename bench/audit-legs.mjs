#!/usr/bin/env node
/**
 * audit-legs.mjs <round-dir> <task> --rc=<version> [--ctl=<version>] [--pmset=<file>]
 * — the 0.48.0 kit's void audit (§7), read-only over a set's records.
 *
 * The runners void two causes live (the version, a cache collapse) because
 * they decide what to run next. The other causes are facts in records that do
 * not change once a leg has ended, so they are read here, after the set, by
 * ONE script — the single definition of "void" the kit names:
 *
 *   version        meta.json's kisoVersion is not EXACTLY its arm's version
 *   tool_hash      the leg's requests carry more than one tool-table hash, or
 *                  not its arm's hash (each arm's hash is the one its legs
 *                  agree on); rc and ctl carrying the SAME hash is not a void
 *                  but an instrument failure — the arms are not what the
 *                  round compares (exit 2)
 *   effort         the two legs of a pair recorded different efforts
 *                  (`effort_bound`, what the runner read back from the
 *                  durable profile)
 *   cache_collapse one leg of a pair under 0.70 cache hit while the other is
 *                  at 0.90 or more (run-paired.sh's rule, re-read)
 *   machine_sleep  `pmset -g log` has a Sleep, Wake or DarkWake inside the
 *                  leg's window (start = the earlier of meta.createdAt and
 *                  end − wall; end = wall_seconds' mtime; ±5 s)
 *
 * A leg found void gets a `void` file ("VOID (audit): <cause> — <detail>")
 * unless it already has one; paired-rows.mjs drops a pair with a void leg.
 * A pair cause voids both legs. The JSON on stdout lists every leg, the
 * void pairs and the PAIR_LIST to re-run them with (`run-paired.sh`), or for
 * an rc-only probe the legs to replace (`run-probe.sh` with PROBE_FIRST).
 *
 * Exit: 0 nothing voided; 1 legs were voided (re-run them, then audit
 * again); 2 the round cannot be judged at all (no legs, identical arms, no
 * trace). Off darwin, machine_sleep is reported as not checkable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";
import { counters } from "./tasks-counters.mjs";

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);
const json = (f) => {
	try {
		return JSON.parse(readFileSync(f, "utf8"));
	} catch {
		return null;
	}
};
const MARGIN_MS = 5_000;

/** The tool-table hashes a leg's main-session requests carried. */
export function toolHashes(work) {
	const dir = join(work, "kiso-home", "sessions", "traces");
	if (!existsSync(dir)) return null;
	const hashes = new Set();
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl") && !x.startsWith("sub-"))) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				const r = JSON.parse(line);
				if (r.kind === "request" && typeof r.toolSchemaHash === "string") hashes.add(r.toolSchemaHash);
			} catch {
				// a torn last line
			}
		}
	}
	return [...hashes];
}

/** Sleep-class events in pmset's log text: [{ ts, kind }]. */
export function powerEvents(text) {
	const out = [];
	for (const line of text.split("\n")) {
		const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (Sleep|Wake|DarkWake)\s/.exec(line);
		if (m) out.push({ ts: Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`), kind: m[5] });
	}
	return out;
}

/** A leg's window in ms: the earlier of meta.createdAt and end − wall, to the end. */
export function legWindow(work) {
	const wallFile = join(work, "wall_seconds");
	if (!existsSync(wallFile)) return null;
	const end = statSync(wallFile).mtimeMs;
	const wall = Number(read(wallFile)) * 1000;
	const created = json(join(work, "meta.json"))?.createdAt;
	const start = Math.min(Number.isFinite(wall) ? end - wall : end, typeof created === "number" ? created : end);
	return { start: start - MARGIN_MS, end: end + MARGIN_MS };
}

const armOf = (run) => (/^rc/.test(run) ? "rc" : /^ctl/.test(run) ? "ctl" : null);
const pairOf = (run) => run.replace(/^(rc|ctl)/, "");

export function audit(root, task, { rc, ctl, pmsetText } = {}) {
	const legs = existsSync(root)
		? readdirSync(root)
				.filter((d) => d.startsWith(`kiso-${task}-`) && existsSync(join(root, d, "wall_seconds")))
				.sort()
		: [];
	const out = { task, legs: [], voidPairs: [], replaceLegs: [], instrument: [], sleepCheckable: pmsetText !== null };
	if (legs.length === 0) {
		out.instrument.push(`no ${task} legs under ${root}`);
		return out;
	}
	const events = pmsetText === null ? [] : powerEvents(pmsetText);
	const rows = legs.map((d) => {
		const work = join(root, d);
		const run = d.slice(`kiso-${task}-`.length);
		return { d, work, run, arm: armOf(run), pair: pairOf(run), already: read(join(work, "void")), causes: [] };
	});
	// each arm's hash: the one its legs agree on (the most common)
	const hashOf = new Map();
	const armHash = {};
	for (const r of rows) {
		const h = toolHashes(r.work);
		hashOf.set(r.run, h);
		if (h === null) out.instrument.push(`${r.d}: no trace — the tool table cannot be read`);
	}
	for (const arm of ["rc", "ctl"]) {
		const tally = new Map();
		for (const r of rows.filter((x) => x.arm === arm)) for (const h of hashOf.get(r.run) ?? []) tally.set(h, (tally.get(h) ?? 0) + 1);
		armHash[arm] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
	}
	if (armHash.rc !== null && armHash.rc === armHash.ctl) out.instrument.push(`rc and ctl carry the same tool-table hash ${armHash.rc.slice(0, 8)} — the arms are not what the round compares`);
	out.armHash = { rc: armHash.rc?.slice(0, 8) ?? null, ctl: armHash.ctl?.slice(0, 8) ?? null };
	for (const r of rows) {
		if (r.arm === null) continue;
		const want = r.arm === "rc" ? rc : ctl;
		const saw = json(join(r.work, "meta.json"))?.kisoVersion ?? "missing";
		if (want !== undefined && saw !== want) r.causes.push(`version: the leg records ${saw}, wanted exactly ${want}`);
		const h = hashOf.get(r.run);
		if (h !== null && (h.length !== 1 || h[0] !== armHash[r.arm])) r.causes.push(`tool_hash: the leg carried ${h.map((x) => x.slice(0, 8)).join("|") || "none"}, its arm ${armHash[r.arm]?.slice(0, 8)}`);
		const w = legWindow(r.work);
		const slept = w === null ? [] : events.filter((e) => e.ts >= w.start && e.ts <= w.end);
		if (slept.length > 0) r.causes.push(`machine_sleep: ${slept.map((e) => `${e.kind} at ${new Date(e.ts).toISOString()}`).join(", ")}`);
	}
	// the pair causes
	const byPair = new Map();
	for (const r of rows) if (r.arm !== null) byPair.set(r.pair, { ...(byPair.get(r.pair) ?? {}), [r.arm]: r });
	for (const [id, p] of byPair) {
		if (p.rc === undefined || p.ctl === undefined) continue;
		const ea = read(join(p.rc.work, "effort_bound"));
		const eb = read(join(p.ctl.work, "effort_bound"));
		if (ea !== eb) for (const r of [p.rc, p.ctl]) r.causes.push(`effort: pair ${id} recorded ${ea ?? "<none>"} (rc) and ${eb ?? "<none>"} (ctl)`);
		const ha = counters(p.rc.work).cacheHit;
		const hb = counters(p.ctl.work).cacheHit;
		if (ha !== null && hb !== null && ((ha < 0.7 && hb >= 0.9) || (hb < 0.7 && ha >= 0.9))) for (const r of [p.rc, p.ctl]) r.causes.push(`cache_collapse: pair ${id} hit ${ha} (rc) / ${hb} (ctl)`);
	}
	// a pair with ONE void leg is a void pair: both legs go
	const paired = ctl !== undefined;
	if (paired) {
		for (const [id, p] of byPair) {
			if (p.rc === undefined || p.ctl === undefined) continue;
			const cause = p.rc.causes[0] ?? p.ctl.causes[0];
			if (cause === undefined) continue;
			for (const r of [p.rc, p.ctl]) if (r.causes.length === 0) r.causes.push(`pair: its partner is void (${cause.split(":")[0]})`);
		}
	}
	for (const r of rows) {
		const voidNow = r.causes.length > 0 && r.already === null;
		if (voidNow) writeFileSync(join(r.work, "void"), `VOID (audit): ${r.causes.join("; ")}\n`);
		out.legs.push({ run: r.run, arm: r.arm, valid: r.causes.length === 0 && r.already === null, causes: r.causes, alreadyVoid: r.already !== null, voidedNow: voidNow });
	}
	const voided = out.legs.filter((l) => l.voidedNow);
	if (paired) out.voidPairs = [...new Set(voided.map((l) => pairOf(l.run)))].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
	else out.replaceLegs = voided.map((l) => l.run);
	out.pairList = out.voidPairs.map((p) => p.replace(/[a-z]+$/, "")).join(" ");
	return out;
}

function main(argv) {
	const [root, task, ...rest] = argv;
	const opt = (k) => rest.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
	if (!root || !task || opt("rc") === undefined) {
		console.error("usage: audit-legs.mjs <round-dir> <task> --rc=<version> [--ctl=<version>] [--pmset=<file>]");
		process.exit(2);
	}
	let pmsetText = null;
	const file = opt("pmset");
	if (file !== undefined) pmsetText = readFileSync(file, "utf8");
	else if (process.platform === "darwin") {
		try {
			pmsetText = execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		} catch {
			pmsetText = null;
		}
	}
	const out = audit(root, task, { rc: opt("rc"), ctl: opt("ctl"), pmsetText });
	console.log(JSON.stringify(out, null, 1));
	process.exit(out.instrument.length > 0 ? 2 : out.legs.some((l) => l.voidedNow) ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
