/**
 * ADR-0063 M2 — session records: the four active kinds, the provenance
 * gate, the authority-aware reducer, the derived cursor, batch identity and
 * the batch writer. The core
 * event (`context_records`) renders nothing in M2: the projection and the
 * effective history are byte-identical with and without record batches.
 */
import { isKisoEvent, projectMessages, type Event } from "@vincemakes/kiso-core";
import { describe, expect, it } from "vitest";
import { effectiveHistory } from "../src/effective-history.js";
import { admitRecord, batchKey, recordCoverage, recordsBatch, reduceRecords, validSupersession, type RecordCandidate, type SessionRecord } from "../src/session-records.js";
import { log } from "./fixtures/history-logs.js";

const S = "session/s1" as const;
const ev = (seq: number) => ({ owner: S, seq });

const history = log([
	{ seq: 0, type: "user_input", content: "Never use Redis for session state." },
	{ seq: 1, type: "text_delta", text: "Understood." },
	{ seq: 2, type: "stop", reason: "end_turn" },
	{ seq: 3, type: "user_input", content: "Use the suggested plan", source: "suggestion" },
	{ seq: 4, type: "user_input", content: "task finished: lint", via: { kind: "tasks" } },
	{ seq: 5, type: "user_input", content: "We tried a worker pool; dropped it because it deadlocked on shutdown." },
	{ seq: 6, type: "user_input", content: "never sent" },
	{ seq: 7, type: "user_input_replaced", replaces: 6, content: null },
]);

const rec = (id: string, over: Partial<SessionRecord>): SessionRecord => ({ id, kind: "decision", text: "x because y", authority: "model", evidence: [ev(1)], freshness: "durable", ...over });
const batch = (seq: number, from: number, to: number, records: SessionRecord[]): Event =>
	({ seq, type: "context_records", batchKey: batchKey("s1", from, to, "none"), coversFromSeq: from, coversToSeq: to, records }) as unknown as Event;

describe("the core event", () => {
	it("a well-formed batch is a kiso event; an empty batch is valid", () => {
		expect(isKisoEvent(batch(10, 0, 9, []))).toBe(true);
		expect(isKisoEvent(batch(10, 0, 9, [rec("r1", {})]))).toBe(true);
	});
	it("malformed batches are corruption", () => {
		const good = batch(10, 0, 9, []) as unknown as Record<string, unknown>;
		expect(isKisoEvent({ ...good, coversFromSeq: 5, coversToSeq: 4 })).toBe(false);
		expect(isKisoEvent({ ...good, coversFromSeq: 9, coversToSeq: 9 })).toBe(false); // an empty range is never a batch
		expect(isKisoEvent({ ...good, coversFromSeq: -1 })).toBe(true); // the cursor before any event
		expect(isKisoEvent({ ...good, coversFromSeq: -2 })).toBe(false);
		expect(isKisoEvent({ ...good, batchKey: "" })).toBe(false);
		expect(isKisoEvent({ ...good, coversToSeq: 10 })).toBe(false); // covers itself
		expect(isKisoEvent({ ...good, records: {} })).toBe(false);
		expect(isKisoEvent({ ...good, batchKey: 7 })).toBe(false);
		expect(isKisoEvent({ ...good, projection: 3 })).toBe(false);
	});
	it("M2 renders nothing: projection and effective history are unchanged by record batches", () => {
		const withBatch = [...history, batch(8, 0, 7, [rec("r1", {})])];
		expect(JSON.stringify(projectMessages(withBatch))).toBe(JSON.stringify(projectMessages(history)));
		expect(JSON.stringify(effectiveHistory(withBatch))).toBe(JSON.stringify(effectiveHistory(history)));
	});
});

describe("kind validation (spec rev 1.2 § 3: the four ADR-0063 kinds)", () => {
	const base: RecordCandidate = { kind: "decision", text: "use SQLite because it needs no server", authority: "model", evidence: [ev(1)] };
	it("the four kinds are active and durable", () => {
		for (const kind of ["constraint", "decision", "rejection", "correction"] as const) expect(admitRecord(history, S, "r", { ...base, kind }).record).toMatchObject({ kind, freshness: "durable" });
	});
	it("change and fix are deferred vocabulary: dropped like any unknown kind until E2 rules", () => {
		expect(admitRecord(history, S, "r", { ...base, kind: "change" as never }).dropped).toBe("unknown kind change");
		expect(admitRecord(history, S, "r", { ...base, kind: "fix" as never }).dropped).toBe("unknown kind fix");
		expect(admitRecord(history, S, "r", { ...base, kind: "fact" as never }).dropped).toBe("unknown kind fact");
	});
	it("the extractor cannot claim tool or external authority: such a claim commits as model", () => {
		expect(admitRecord(history, S, "r", { ...base, authority: "tool" }).record?.authority).toBe("model");
		expect(admitRecord(history, S, "r", { ...base, authority: "external" }).record?.authority).toBe("model");
	});
	it("empty text is dropped", () => {
		expect(admitRecord(history, S, "r", { ...base, text: "  " }).dropped).toBe("empty text");
	});
});

describe("the batch writer (spec rev 1 § 6)", () => {
	it("M2 never writes projection; a range with nothing new writes no batch", () => {
		const b = recordsBatch("s1", 7, 11, 9, []);
		expect(b).toEqual({ type: "context_records", batchKey: "s1:7:11:9", coversFromSeq: 7, coversToSeq: 11, records: [] });
		expect(b !== null && "projection" in b).toBe(false);
		expect(recordsBatch("s1", 11, 11, "none", [])).toBeNull();
		expect(recordsBatch("s1", -1, 0, "none", [])?.coversFromSeq).toBe(-1);
	});
});

describe("the provenance gate (spec § 4, Q3)", () => {
	it("a user constraint keeps the source's exact bytes", () => {
		const r = admitRecord(history, S, "r1", { kind: "constraint", text: "no Redis for sessions", authority: "user", evidence: [ev(0)], quote: { ...ev(0), span: "Never use  Redis for session state." } });
		expect(r.record?.authority).toBe("user");
		expect(r.record?.quote?.span).toBe("Never use Redis for session state.");
	});
	it("a normative kind whose user claim fails is dropped, never downgraded", () => {
		for (const seq of [1, 3, 4, 6]) {
			const r = admitRecord(history, S, "r", { kind: "constraint", text: "t", authority: "user", evidence: [ev(seq)], quote: { ...ev(seq), span: seq === 1 ? "Understood." : seq === 3 ? "Use the suggested plan" : seq === 4 ? "task finished" : "never sent" } });
			expect(r.record).toBeUndefined();
			expect(r.dropped).toBe("user quote failed the provenance check");
		}
		expect(admitRecord(history, S, "r", { kind: "rejection", text: "t", authority: "user", evidence: [ev(5)] }).dropped).toBe("user quote failed the provenance check");
	});
	it("a decision whose user claim fails is dropped too: a downgrade would keep a false attribution in its text (GPT's M2a review)", () => {
		for (const text of ["The user decided to use the plan.", "use the plan because chosen"]) {
			const r = admitRecord(history, S, "r", { kind: "decision", text, authority: "user", evidence: [ev(3)], quote: { ...ev(3), span: "Use the suggested plan" } });
			expect(r.record).toBeUndefined();
			expect(r.dropped).toBe("user quote failed the provenance check");
		}
	});
	it("no admitted record claims the person's authority without the person's own located words", () => {
		const claims = [0, 1, 3, 4, 5, 6].flatMap((seq) => (["constraint", "decision", "rejection", "correction"] as const).map((kind) => admitRecord(history, S, "r", { kind, text: "t", authority: "user", evidence: [ev(seq)], quote: { ...ev(seq), span: "Never use Redis for session state." } })));
		for (const a of claims) if (a.record) expect(a.record.authority === "user" && a.record.quote?.span === "Never use Redis for session state." && a.record.quote.seq === 0).toBe(true);
		expect(claims.filter((a) => a.record).length).toBe(4); // only seq 0's four kinds
	});
	it("a quote from another owner's log is refused", () => {
		const r = admitRecord(history, S, "r", { kind: "constraint", text: "t", authority: "user", evidence: [ev(0)], quote: { owner: "work/w1", seq: 0, span: "Never use" } });
		expect(r.dropped).toBe("user quote failed the provenance check");
	});
});

describe("the reducer (ADR-0063 § 5.1)", () => {
	const A = ["user", "external", "model", "tool"] as const;
	it("the supersession matrix, every cell", () => {
		const expected: Record<string, boolean> = {
			"user>user": true, "user>external": true, "user>model": true, "user>tool": true,
			"external>user": false, "external>external": true, "external>model": true, "external>tool": true,
			"model>user": false, "model>external": false, "model>model": true,
			"tool>user": false, "tool>external": false, "tool>model": true,
		};
		for (const s of A) for (const t of A) {
			const key = `${s}>${t}`;
			// "per kind" (ADR-0063 § 5.1): no active kind lets model or tool supersede tool
			if (key === "model>tool" || key === "tool>tool") {
				for (const kind of ["constraint", "decision", "rejection", "correction"] as const) expect(validSupersession({ authority: s, kind }, { authority: t, kind }), key).toBe(false);
			} else expect(validSupersession({ authority: s, kind: "decision" }, { authority: t, kind: "decision" }), key).toBe(expected[key]);
		}
	});
	it("append-only: a valid supersession retires the target; an invalid one is ignored and reported, the source still commits", () => {
		const r18 = rec("r18", { kind: "constraint", authority: "user", text: "no Redis", quote: { ...ev(0), span: "Never use Redis for session state." } });
		const fake = rec("r47", { kind: "correction", authority: "model", text: "the user now allows Redis", supersedes: ["r18"] });
		const out = reduceRecords([batch(8, 0, 7, [r18]), batch(9, 7, 8, [fake])]);
		expect(out.active.map((r) => r.id)).toEqual(["r18", "r47"]);
		expect(out.ignored).toEqual([{ source: "r47", target: "r18", why: "model cannot supersede user" }]);
		const real = rec("r50", { kind: "correction", authority: "user", text: "Redis allowed", supersedes: ["r18"], quote: { ...ev(5), span: "We tried" } });
		expect(reduceRecords([batch(8, 0, 7, [r18]), batch(9, 7, 8, [real])]).active.map((r) => r.id)).toEqual(["r50"]);
	});
	it("a supersedes naming an unknown id is ignored and reported", () => {
		const out = reduceRecords([batch(8, 0, 7, [rec("r1", { supersedes: ["nope"] })])]);
		expect(out.ignored).toEqual([{ source: "r1", target: "nope", why: "unknown target" }]);
	});
});

describe("cursor and batch identity (ADR-0063 § 5.3)", () => {
	it("the cursor is derived from committed batches only; empty batches advance it", () => {
		expect(recordCoverage(history)).toBe(-1);
		expect(recordCoverage([...history, batch(8, 0, 7, [])])).toBe(7);
		expect(recordCoverage([...history, batch(8, 0, 7, []), batch(12, 7, 11, [rec("r1", {})])])).toBe(11);
	});
	it("the batch key names the session, the range and the checkpoint", () => {
		expect(batchKey("s1", 0, 7, "none")).toBe("s1:0:7:none");
		expect(batchKey("s1", 0, 7, 42)).toBe("s1:0:7:42");
		expect(batchKey("s1", 0, 7, 42)).not.toBe(batchKey("s1", 0, 7, 43));
	});
});
