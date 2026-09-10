/**
 * DF-0322-F1 — the sidecars beside the session log are private too.
 *
 * Found in the 0.32.2 post-release dogfood by measuring the whole home
 * rather than the file R6 was about. R6 made the log 0600 and the sessions
 * directory 0700; written beside them and untouched were `<id>.meta.json`
 * (the execution profile) at 0644 and `traces/` at 0755 with its ledger at
 * 0644.
 *
 * WHAT IS AND IS NOT EXPOSED, measured rather than assumed:
 *
 * On a FRESH home the parent chain is 0700, so another user cannot
 * traverse in and the sidecars' own bits are defence in depth, not a live
 * exposure. On a PRE-EXISTING home — which R6 deliberately does not
 * migrate — the chain is 0755 and open, so a NEW session's log is private
 * while its sidecars are readable by every local user. That interaction is
 * the finding: the two rules were each right and their overlap was not.
 *
 * Neither sidecar carries prompt text. The profile holds the model
 * binding; the ledger holds hashes, token counts and latencies. What
 * leaked was metadata — which model, when, how much — which is a smaller
 * thing than R6 closed and still nobody's business by default.
 *
 * Existing files stay as they are, exactly as R6 chose: this fixes what
 * kiso CREATES, never what it finds.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProfile } from "../src/profile.js";

const modeOf = (p: string): string => (statSync(p).mode & 0o777).toString(8);

let saved: number;
beforeEach(() => {
	saved = process.umask(0o022); // the common default, and the one that exposed this
});
afterEach(() => {
	process.umask(saved);
});

const profile = {
	revision: 1,
	at: "2026-09-10T10:38:47.089Z",
	modelId: "a-model",
	provider: { providerId: "p", apiId: "a", modelId: "a-model" },
} as never;

describe("DF-0322-F1 — the profile sidecar", () => {
	it("is 0600, not 0644 — the binding is not the world's business", () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-df0322-"));
		writeProfile(root, "s1", profile);
		expect(modeOf(join(root, "s1.meta.json"))).toBe("600");
	});

	it("stays 0600 across a rewrite — the atomic rename does not widen it", () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-df0322-rewrite-"));
		writeProfile(root, "s1", profile);
		writeProfile(root, "s1", { ...(profile as object), revision: 2 } as never);
		expect(modeOf(join(root, "s1.meta.json"))).toBe("600");
	});
});

describe("DF-0322-F1 — the trace ledger", () => {
	it("its directory is 0700 and the ledger is 0600", async () => {
		const { TraceWriter } = await import("../src/trace/writer.js");
		const root = mkdtempSync(join(tmpdir(), "kiso-df0322-trace-"));
		const w = new TraceWriter({ root, sessionId: "s1" });
		// init() writes the header through the same synchronous path every
		// later line takes, so the file exists — and exists at the mode the
		// creating call gave it — by the time init() returns.
		w.init();
		expect(modeOf(join(root, "traces")), "the ledger directory lists to the world").toBe("700");
		expect(modeOf(join(root, "traces", "s1.jsonl")), "the ledger reads to the world").toBe("600");
	});
});
