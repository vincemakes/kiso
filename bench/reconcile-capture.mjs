/**
 * Does the captured traffic agree with the leg's own usage record?
 *
 * A directory full of request bodies proves nothing on its own. If the
 * proxy missed requests — an arm that opened a second connection, a
 * retry that bypassed it, a leg that started before the proxy was up —
 * then the bodies describe a DIFFERENT session from the one the usage
 * numbers came from, and every conclusion drawn by putting them side by
 * side is about a session that never happened.
 *
 * So the capture is admitted only when it reconciles, and the checks are
 * the ones that can actually fail:
 *
 *   COUNT      one archived body per request the arm recorded. Not "about
 *              as many": a missing body is a request whose content is
 *              unknown, and unknown content cannot be decomposed.
 *   MODEL      every body names the model the leg declares. A body naming
 *              another model is a different session sharing a directory.
 *   EFFORT     every body carries the arm's effort field. This is the
 *              read-back the other arm has never had — its level was
 *              REQUESTED and unverified, and a captured body is the first
 *              thing that can say it was sent.
 *   GROWTH     a session's bodies grow. Reported, not gated: a compaction
 *              legitimately shrinks one, so a drop is a fact to show
 *              beside the cache numbers, not a failure.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const EFFORT_KEYS = ["reasoning_effort", "reasoningEffort", "thinking", "reasoning"];

/** Pull the effort out of a body, whatever the vendor calls it. */
export function effortOf(body) {
	for (const k of EFFORT_KEYS) {
		const v = body?.[k];
		if (typeof v === "string") return v;
		if (v && typeof v === "object") {
			if (typeof v.effort === "string") return v.effort;
			if (typeof v.type === "string") return v.type;
		}
	}
	return null;
}

/**
 * TWO SOURCES, because one arm must not be proxied.
 *
 * A loopback base URL defeats our own endpoint-keyed metadata lookup —
 * `lookupModelMetadata(model, baseUrl)` finds nothing for 127.0.0.1, the
 * reasoning capability reads null, and `/model ds high` is REFUSED. Every
 * leg would then be `effort_not_bound`: the whole round void, after the
 * money. It also moves credential resolution onto a path that is not the
 * one under test.
 *
 * So our arm dumps its own bodies (`KISO_DUMP_REQUESTS=<dir>`, a permanent
 * debug sink in the openai-compat adapter, silent on failure, no proxy and
 * no endpoint change), and the proxy is for the OTHER arm, which has no
 * such sink. The two file shapes:
 *
 *   proxy  req-00001.json      { seq, path, headers, bodySha256, body }
 *   dump   req-<pid>-<seq>.json  the bare request body
 *
 * The dump's counter is per PROCESS, and T5 runs three processes per leg,
 * so ordering is by pid and THEN seq — sorting the names as strings
 * interleaves the processes and puts request 10 before request 2.
 */
export function readCapture(dir) {
	if (!existsSync(dir)) return null;
	const names = readdirSync(dir);

	const proxied = names.filter((f) => /^req-\d+\.json$/.test(f))
		.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
	// ORDER ACROSS PROCESSES IS NOT THE PID ORDER. A pid is not guaranteed
	// to rise with start time — the OS reuses and wraps them — so sorting
	// by pid encoded an assumption the gate did not check. With three
	// sequential processes per leg it is near-certain, and near-certain is
	// not checked. The file's mtime IS the write time, which is the request
	// time, so it orders across processes on a fact rather than a habit.
	// Within a process the seq is authoritative and breaks an mtime tie
	// (two requests can land in the same timestamp tick).
	const dumped = names.filter((f) => /^req-\d+-\d+\.json$/.test(f))
		.map((f) => {
			const [, pid, seq] = f.match(/^req-(\d+)-(\d+)\.json$/);
			let mtime = 0;
			try { mtime = statSync(join(dir, f)).mtimeMs; } catch { /* unreadable: falls back to pid/seq below */ }
			return { f, pid: Number(pid), seq: Number(seq), mtime };
		})
		.sort((a, b) => (a.mtime - b.mtime) || (a.pid - b.pid) || (a.seq - b.seq));

	const recs = [];
	for (const f of proxied) {
		try { recs.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch { /* a torn write is not a request */ }
	}
	for (const { f, pid, seq, mtime } of dumped) {
		try {
			const body = JSON.parse(readFileSync(join(dir, f), "utf8"));
			// the dump has no envelope; give it the same shape so one set of
			// gates reads both sources rather than two sets drifting apart
			recs.push({ seq, pid, mtime, path: "(dumped by the adapter)", source: "dump", body,
				bodyBytes: JSON.stringify(body).length });
		} catch { /* a torn write is not a request */ }
	}
	return recs;
}

/**
 * @param recs     what readCapture returned
 * @param expected { requests, model }  from the leg's own record
 */
export function reconcile(recs, expected) {
	const problems = [];
	if (recs === null) return { ok: false, problems: ["no capture directory"], checked: 0 };

	// Only completion calls count: a proxy also sees model lists, health
	// checks and whatever else an arm asks for, and those are not requests
	// the usage ledger counts.
	const calls = recs.filter((r) => r.body && (r.body.messages || r.body.input || r.body.prompt));

	if (expected.requests !== null && expected.requests !== undefined && calls.length !== expected.requests) {
		problems.push(`captured ${calls.length} model calls, the leg recorded ${expected.requests} requests`);
	}

	const models = new Set(calls.map((r) => r.body.model).filter(Boolean));
	if (expected.model && (models.size !== 1 || !models.has(expected.model))) {
		problems.push(`bodies name ${JSON.stringify([...models])}, the leg declares ${JSON.stringify(expected.model)}`);
	}

	// `calls` are RECORDS; the effort lives in the record's BODY. Passing
	// the record read null for every request and reported a capture with a
	// perfectly good effort field as carrying none — the unit test of
	// effortOf stayed green throughout, which is what localised it.
	const efforts = calls.map((r) => effortOf(r.body));
	const missingEffort = efforts.filter((e) => e === null).length;
	const distinct = [...new Set(efforts.filter(Boolean))];
	// `none` is the PROVIDER'S DEFAULT, declared for both arms (a route where
	// the effort switch cannot bind — the 0.46.0 evaluation): it is verified
	// as ABSENCE, every body carrying no effort field at all.
	const atDefault = expected.effort === "none";
	if (atDefault) {
		const carrying = calls.length - missingEffort;
		if (carrying > 0) problems.push(`${carrying} of ${calls.length} bodies carry an effort field, the leg declares none`);
	} else if (expected.effort) {
		if (missingEffort > 0) problems.push(`${missingEffort} of ${calls.length} bodies carry no effort field`);
		else if (distinct.length !== 1 || distinct[0] !== expected.effort) {
			problems.push(`bodies carry effort ${JSON.stringify(distinct)}, the leg declares ${JSON.stringify(expected.effort)}`);
		}
	}

	// reported, never gated
	const sizes = calls.map((r) => r.bodyBytes ?? 0);
	const shrinks = [];
	for (let i = 1; i < sizes.length; i += 1) if (sizes[i] < sizes[i - 1]) shrinks.push({ at: i + 1, from: sizes[i - 1], to: sizes[i] });

	return {
		ok: problems.length === 0,
		problems,
		checked: calls.length,
		nonCallRecords: recs.length - calls.length,
		effortObserved: atDefault && calls.length > 0 && missingEffort === calls.length ? "none" : distinct.length === 1 ? distinct[0] : distinct,
		bytesFirst: sizes[0] ?? null,
		bytesLast: sizes[sizes.length - 1] ?? null,
		shrinks,
	};
}

/**
 * PRE-FLIGHT, 2026-09-16, offline and free — no real endpoint contacted.
 *
 * The open question was whether the other arm's `--thinking high` survives
 * a custom base URL, because if it did not, every leg of that arm would be
 * `effort_not_bound` and the capture would buy nothing.
 *
 * It survives. Its model store rewritten into an isolated HOME with every
 * `baseUrl` pointed at the capture proxy, and a fake upstream answering so
 * nothing real was called, the arm's first request body carried BOTH
 * spellings:
 *
 *     reasoning_effort  "high"
 *     thinking          {"type": "enabled"}
 *
 * reconcile() read `effortObserved: "high"` from it. The credential
 * appeared nowhere in the archived record — the header allowlist holding
 * on real traffic, not only on the synthetic case.
 *
 * The older note that "it honours neither DEEPSEEK_BASE_URL nor
 * OPENAI_BASE_URL" is about ENVIRONMENT VARIABLES and stands; the model
 * store is a different route and it works.
 */
