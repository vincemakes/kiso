/**
 * R-H 0.1.49 — the envelope-shape drift gate (ADR-0051 §2, ruling R2a):
 * the persisted record envelope is EXACTLY {runId, ts, event} — no
 * schemaVersion, no added keys, no missing keys (B1a follows from the
 * same pin). Probe 1: the LIVE write path — a real run through the
 * product's own loop. Probe 2: the whole generation corpus — every line
 * of every fixture, written by four published bins across three
 * generations. Any envelope drift is a contract amendment: red.
 */

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const FIXTURE_DIR = new URL("./fixtures/sessions/", import.meta.url);

/** The one legal envelope: {runId, ts, event}. Returns the violation or
 *  null. */
function envelopeViolation(record: unknown): string | null {
	if (typeof record !== "object" || record === null) return "not an object";
	const keys = Object.keys(record).sort();
	if (keys.join(",") !== "event,runId,ts") return `keys: ${keys.join(",")}`;
	const r = record as { runId: unknown; ts: unknown; event: unknown };
	if (typeof r.runId !== "string") return "runId not a string";
	if (typeof r.ts !== "number") return "ts not a number";
	if (typeof r.event !== "object" || r.event === null) return "event not an object";
	return null;
}

describe("R-H 0.1.49 — the envelope-shape drift gate (R2a/B1a)", () => {
	it("probe 1: the live write path persists exactly {runId, ts, event}", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-env-"));
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		const seen: unknown[] = [];
		for await (const ev of session.run("go")) seen.push(ev);
		const records = new SessionStore(dir).load("s");
		expect(records.length).toBeGreaterThan(0);
		for (const r of records) expect(envelopeViolation(r)).toBeNull();
	});

	it("probe 2: every line of every generation sample has the exact envelope", () => {
		const files = readdirSync(FIXTURE_DIR.pathname).filter((f) => f.endsWith(".jsonl")).sort();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const lines = readFileSync(join(FIXTURE_DIR.pathname, f), "utf8").split("\n").filter(Boolean);
			for (const line of lines) {
				expect(envelopeViolation(JSON.parse(line))).toBeNull();
			}
		}
	});

	it("no event carries a schemaVersion — B1a: the envelope is the only shape", () => {
		const files = readdirSync(FIXTURE_DIR.pathname).filter((f) => f.endsWith(".jsonl")).sort();
		for (const f of files) {
			const lines = readFileSync(join(FIXTURE_DIR.pathname, f), "utf8").split("\n").filter(Boolean);
			for (const line of lines) {
				expect("schemaVersion" in JSON.parse(line).event).toBe(false);
			}
		}
	});
});
