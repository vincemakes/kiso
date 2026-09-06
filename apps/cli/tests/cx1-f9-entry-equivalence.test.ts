/**
 * CX-1 F9 — one execution config through every entry point.
 *
 * `kiso chat <id>` resolved autoCompact from the merged config;
 * the bare `kiso <id>` path passed `autoCompactFromEnv()` — env only —
 * so a user's config.json autoCompact worked on one documented entry
 * and silently vanished on the default one (audit F9, static trace).
 *
 * The gate is behavioral, not textual: the same config.json, the same
 * five turns, the same faux script — both entry points must reach the
 * post-run auto-compaction and leave a `summarized` event in the log.
 * KISO_AUTO_COMPACT is unset throughout (the env override is not the
 * subject; the config path is).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const SUMMARY =
	"## Goal\nfive rounds\n## Constraints\nnone\n## User requests\nfive hellos\n## Files and changes\nnone\n## Errors and fixes\nnone\n## Current work\nsummarized\n## Next steps\nkeep going";

function fixture(): { env: NodeJS.ProcessEnv; home: string } {
	const { env, dirs } = isolatedEnv();
	delete env.KISO_AUTO_COMPACT;
	// a threshold any single turn clears — the config path is the subject
	writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify({ autoCompact: { thresholdRatio: 0.0001 } })}\n`, "utf8");
	const dir = mkdtempSync(join(tmpdir(), "kiso-cx1-f9-"));
	const script = join(dir, "faux.json");
	const turns = Array.from({ length: 5 }, (_, i) => ({ events: [{ type: "text_delta", text: `reply ${i + 1}` }, { type: "stop", reason: "end_turn" }] }));
	turns.push({ events: [{ type: "text_delta", text: SUMMARY }, { type: "stop", reason: "end_turn" }] });
	writeFileSync(script, JSON.stringify(turns), "utf8");
	return { env: { ...env, KISO_FAUX_SCRIPT: script } as NodeJS.ProcessEnv, home: dirs.home };
}

const FIVE = "hi\nhi\nhi\nhi\nhi\nexit\n";

describe("CX-1 F9 — entry-point equivalence for autoCompact", () => {
	it("`kiso chat <id>` honors config.json autoCompact (the reference behavior)", () => {
		const { env, home } = fixture();
		const res = runCli(["chat", "f9-chat"], env, { input: FIVE, timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		const log = readFileSync(join(home, "sessions", "f9-chat.jsonl"), "utf8");
		expect(log).toContain('"summarized"');
	});

	it("bare `kiso <id>` honors the SAME config.json autoCompact — the default entry is not the odd one out", () => {
		const { env, home } = fixture();
		const res = runCli(["f9-bare"], env, { input: FIVE, timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		const log = readFileSync(join(home, "sessions", "f9-bare.jsonl"), "utf8");
		expect(log).toContain('"summarized"');
	});
});
