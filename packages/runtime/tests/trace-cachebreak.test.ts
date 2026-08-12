/**
 * E1 (1.2.0) — slice 4, the cache-break derivation (proposal §4, ruling
 * R4b as adjudicated: per-segment hashes + prefix fingerprint, the break
 * count is an analysis-side derivation).
 *
 * Known-break fixtures: two adjacent requests' cacheable-prefix hashes
 * (everything EXCEPT the current turn — freshness "fresh" is never
 * cacheable) must yield exactly one break at the right depth when a
 * middle turn changed, zero when nothing cacheable changed (even when
 * the current turn did!), depth 0 on a system-prompt change, and a
 * break at the old prefix length when a new turn joined. The
 * fingerprint follows the same boundary: the current turn's hash is
 * never part of it.
 *
 * R4a (the magnitude gate): the per-request assembly — hashContext +
 * manifest + per-segment hashes + fingerprint, the exact hot path the
 * guard runs — must stay in the milliseconds on a T5-shaped context
 * (tens of KB, hundreds of messages). A seconds-scale assembly is a
 * hot-path pollution stop (stop clause e) and fails here.
 */

import { describe, expect, it } from "vitest";
import type { Event, Message, ToolSpec } from "@vincemakes/kiso-core";
import { buildContextManifest, segmentHashes } from "../src/trace/manifest.js";
import { cacheableHashes, deriveBreaks, prefixBreak } from "../src/trace/analyze.js";
import { stablePrefixFingerprint } from "../src/trace/hash.js";
import { hashContext } from "../src/trace/hash.js";
import type { TraceSegment } from "../src/trace/record.js";

/** A placeholder 64-hex segment hash. */
const H = (c: string) => c.repeat(64);

const seg = (role: TraceSegment["role"], freshness: TraceSegment["freshness"]): TraceSegment => ({
	role,
	seqRange: null,
	estTokens: 1,
	freshness,
});

/** A T5-shaped context manifest: system/tools head, four cache_read
 *  turns, one fresh current turn. */
const MANIFEST: TraceSegment[] = [
	seg("system", "cache_read"),
	seg("tools", "cache_read"),
	seg("turn", "cache_read"),
	seg("turn", "cache_read"),
	seg("turn", "cache_read"),
	seg("turn", "cache_read"),
	seg("current_turn", "fresh"),
];

// The cacheable prefix is everything but the last (fresh) segment.
const A = [H("s"), H("t"), H("1"), H("2"), H("3"), H("4")];
const A_AGAIN = [H("s"), H("t"), H("1"), H("2"), H("3"), H("4")];
const T2_MODIFIED = [H("s"), H("t"), H("1"), H("2x"), H("3"), H("4")];
const SYS_CHANGED = [H("sx"), H("t"), H("1"), H("2"), H("3"), H("4")];
const TURN_JOINED = [H("s"), H("t"), H("1"), H("2"), H("3"), H("4"), H("5")];
const CURRENT_ONLY_CHANGED = [H("s"), H("t"), H("1"), H("2"), H("3"), H("4")];

describe("E1 slice 4 — the cache-break derivation (R4b)", () => {
	it("the cacheable prefix excludes the current turn (freshness fresh)", () => {
		expect(cacheableHashes(MANIFEST, [...A, H("cur")])).toEqual(A);
		// one fresh segment dropped, the rest survive in order
		const twoFresh = [seg("system", "cache_read"), seg("current_turn", "fresh")];
		expect(cacheableHashes(twoFresh, [H("a"), H("b")])).toEqual([H("a")]);
	});

	it("an unchanged prefix is zero breaks, even when the current turn changed", () => {
		// A_AGAIN vs CURRENT_ONLY_CHANGED differ only in their (fresh)
		// current turn — the cacheable prefix is identical → 0 breaks
		expect(prefixBreak(A, A_AGAIN)).toBeNull();
		expect(prefixBreak(A, CURRENT_ONLY_CHANGED)).toBeNull();
	});

	it("a middle turn modified → exactly one break at the right depth", () => {
		// the 4th cacheable segment (index 3 = the third turn) changed
		expect(prefixBreak(A, T2_MODIFIED)).toEqual({ depth: 3 });
	});

	it("a system-prompt change breaks at depth 0", () => {
		expect(prefixBreak(A, SYS_CHANGED)).toEqual({ depth: 0 });
	});

	it("a new turn joining breaks at the old prefix length", () => {
		// the prefix grew: identical up to the old length, break where
		// the new segment starts
		expect(prefixBreak(A, TURN_JOINED)).toEqual({ depth: A.length });
	});

	it("deriveBreaks chains requests relative to their predecessor", () => {
		// [A, A_AGAIN, T2_MODIFIED] → first request has no predecessor
		expect(deriveBreaks([A, A_AGAIN, T2_MODIFIED])).toEqual([null, null, { depth: 3 }]);
		// a single request derives to a single null
		expect(deriveBreaks([A])).toEqual([null]);
	});

	it("the fingerprint follows the same boundary: current-turn changes never move it", () => {
		// A and CURRENT_ONLY_CHANGED carry identical cacheable prefixes —
		// the fingerprint (sha-256 over the joined prefix hashes) matches
		expect(stablePrefixFingerprint(A)).toBe(stablePrefixFingerprint(CURRENT_ONLY_CHANGED));
		expect(stablePrefixFingerprint(A)).toBe(stablePrefixFingerprint(A_AGAIN));
		// any cacheable change moves it
		expect(stablePrefixFingerprint(A)).not.toBe(stablePrefixFingerprint(T2_MODIFIED));
		expect(stablePrefixFingerprint(A)).not.toBe(stablePrefixFingerprint(SYS_CHANGED));
	});
});

describe("E1 slice 4 — R4a: the per-request assembly magnitude gate", () => {
	it("a T5-shaped context assembles in milliseconds (hot-path stop)", () => {
		const systemPrompt = "system\n".repeat(2_000); // ~14 KB
		const tools: ToolSpec[] = [{ name: "read_file", description: "r".repeat(120), inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
		const log: Event[] = [];
		const messages: Message[] = [];
		let seq = 0;
		for (let turn = 0; turn < 40; turn++) {
			log.push({ seq: ++seq, type: "user_input", content: `turn ${turn} request` });
			messages.push({ role: "user", content: `turn ${turn} request` });
			for (let k = 0; k < 3; k++) {
				messages.push({
					role: "assistant",
					blocks: [
						{ type: "text", text: `assistant answer ${turn}.${k} `.repeat(40) }, // ~2 KB per block
						{ type: "tool_use", callId: `c${turn}.${k}`, name: "read_file", input: { path: `f${k}.txt` } },
					],
				});
				messages.push({ role: "tool", callId: `c${turn}.${k}`, content: "file contents ".repeat(30), isError: false });
			}
		}
		// ~40 turns × 5 messages × ~3 KB ≈ 600 KB of projection — well
		// beyond the T5 shape; the assembly must still stay in ms
		const REPS = 10;
		const t0 = performance.now();
		for (let i = 0; i < REPS; i++) {
			const manifest = buildContextManifest({ log, systemPrompt, tools, messages });
			const hashes = segmentHashes(systemPrompt, tools, messages);
			stablePrefixFingerprint(cacheableHashes(manifest, hashes));
			hashContext(systemPrompt, tools, messages);
		}
		const perRequestMs = (performance.now() - t0) / REPS;
		// The magnitude gate (R4a): seconds-scale assembly = hot-path
		// pollution = stop clause e. 25 ms is ~10× the observed cost of
		// this shape; anything over it is a complexity blowup, not noise.
		expect(perRequestMs).toBeLessThan(25);
	});
});
