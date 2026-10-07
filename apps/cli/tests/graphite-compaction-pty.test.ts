/**
 * Graphite, the compaction round (owner, 2026-10-06) — a summary inside a
 * run, on a real pty. While the summary call runs, the live row is the one
 * `/compact` draws — `compacting · auto`, its progress in the bar's `▆`
 * cells — not `working` with a clock and nothing arriving; when the summary
 * is kept, the COMPACTED row says the numbers.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");
const BIG = "line of source text\n".repeat(2_000); // ~10k tokens a round

/** A session with five settled read rounds (~50k tokens) — enough that a
 *  checkpoint over them shrinks the context, so the summary is kept. */
async function seed(home: string, id: string): Promise<number> {
	const store = new SessionStore(join(home, "sessions"));
	let seq = 0;
	await store.append(id, "r1", { seq: seq++, type: "user_input", content: "work through the repo" });
	for (let i = 0; i < 5; i++) {
		await store.append(id, "r1", { seq: seq++, type: "tool_call_end", callId: `s${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		await store.append(id, "r1", { seq: seq++, type: "stop", reason: "tool_use" });
		await store.append(id, "r1", { seq: seq++, type: "tool_result", callId: `s${i}`, content: BIG, isError: false });
	}
	await store.append(id, "r1", { seq: seq++, type: "text_delta", text: "read them all" });
	await store.append(id, "r1", { seq: seq++, type: "stop", reason: "end_turn" });
	await store.append(id, "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
	// the writer's lock goes with the seeding: held, the CLI's run fails
	// with "locked by another writer"
	store.close(id);
	return 6; // the faux script's durable position: five results and one end_turn
}

describe("the compaction round on a real pty", () => {
	it("an in-run summary draws the compacting row while it runs, then a COMPACTED row with the numbers", async () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "full-access", KISO_THEME: "dark" });
		const skip = await seed(dirs.home, "cmp-s");
		env.KISO_FAUX_SCRIPT = fauxScript([
			...spares(skip),
			// the run's first response bills a context past the hard tier
			{ events: [{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} }, { type: "usage", inputTokens: 175_000, outputTokens: 200, cacheRead: 174_000, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
			// the summary call, slow enough to be seen
			{ events: [{ type: "delay", ms: 2500 }, { type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "carried on." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const raw = ptyRun(["chat", "cmp-s"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "continue\r"],
				["carried on.", "exit\r"],
			],
			timeout: 60,
		});
		const t = plain(raw);
		expect(t, "the live row while the summary ran").toMatch(/compacting · auto · \d+ rounds? · ~[\d.]+k → /);
		expect(raw, "its progress in the bar's cells").toMatch(/compacting · auto[^\n]*▆/);
		expect(raw, "not the retired glyphs").not.toMatch(/compacting · auto[^\n]*[▰▱]/);
		expect(t, "the COMPACTED row says the numbers").toMatch(/COMPACTED {3}mid-run · ~[\d.]+k → ~[\d.]+k · ctx now \d+%/);
		expect(t, "the sentence it replaced").not.toContain("the conversation before this point is a summary now");
		expect(t, "the raw event row under it").not.toContain("[summarized up to seq");
	}, 120_000);
});
