/**
 * DC-41 — the two keys traded jobs, and they do not cross.
 *
 * ctrl+o expands the newest fold in the stream; ctrl+r opens and closes
 * the transcript viewer (owner ruling 2026-09-02). Until 0.20.4 it was
 * the other way round, on R5's bet that a borrowed key carries muscle
 * memory: it carries the KEY and betrays the ACTION, because elsewhere
 * ctrl+o expands the tool output in front of you — which is §7.7's job.
 *
 * Each key already has a gate of its own (tui-v7-expand, r5-viewer-pty),
 * and each was simply re-pointed at the other byte when the swap landed.
 * Neither can catch the failure this round can actually produce: a
 * dispatch where one byte reaches BOTH handlers, or where the gated
 * viewer swallows a press the ungated expand should have had. That is a
 * property of the two keys TOGETHER, in one session, so it is measured
 * in one session — the keys pressed in sequence through a real pty, and
 * the transcript read for the two surfaces in the order they were asked
 * for.
 *
 * The keys ride `delays` rather than `feeds` deliberately: a needle
 * matched against raw bytes is the repo's fifth-most-repeated mistake
 * (`✦ took` is `\x1b[2m✦\x1b[0m took` on the wire), and a needle that
 * never matches spends the whole wall and reports as a product timeout.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

/** One shell call with enough output to hide rows — so the settled card
 *  advertises the expand key and there is something for it to open. */
function turns(): unknown[] {
	return [
		{
			events: [
				{ type: "text_delta", text: "Running it." },
				{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "seq 1 8" } },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{ events: [{ type: "text_delta", text: "that is done." }, { type: "stop", reason: "end_turn" }] },
		...spares(4),
	];
}

function session(): string {
	const ws = mkdtempSync(join(tmpdir(), "kiso-dc41-"));
	writeFileSync(join(ws, "note.txt"), "alpha\nbeta\n", "utf8");
	const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(turns()), KISO_MODE: "bypass" });
	return ptyRun(["--mode", "bypass", "dc41-key-swap"], env as NodeJS.ProcessEnv, {
		feeds: [["▌ ", "go\r"]],
		delays: [
			[6, "\x0f"], // ctrl+o — expand the newest fold, in the stream
			[8, "\x12"], // ctrl+r — open the viewer
			[10, "\x12"], // ctrl+r again — the key that opens it puts it away
			[12, "exit\r"],
		],
		timeout: 40,
		cwd: ws,
	});
}

describe("DC-41 — ctrl+o expands, ctrl+r reads back, and neither does the other's job", () => {
	/** ONE session, read three ways. Three sessions would be three times
	 *  the wall for the same twelve seconds of keys, and the property
	 *  under test is about the keys in SEQUENCE anyway.
	 *
	 *  MEMOISED, not `beforeAll`: a hook that throws marks the cases
	 *  SKIPPED, and a skip is neither green nor red — it reads as "fine"
	 *  in a summary line while asserting nothing. Lazily, the throw lands
	 *  inside the first case and the file goes red, which is what a gate
	 *  that cannot be satisfied is supposed to do. */
	let memo: string | null = null;
	const transcript = (): string => (memo ??= session());

	it("both surfaces appear, in the order the keys were pressed", () => {
		const raw = transcript();
		// NEEDLE MOVED (0.24.2 ③): the expansion is a card and its head row
		// names the CALL first — `shell … · expanded · N turns back` —
		// where the old block led with `✦ expanded · shell …`. The needle
		// is the part that only an expansion says.
		const expandedAt = raw.indexOf("· expanded ·");
		const viewerAt = raw.indexOf("esc closes");
		expect(expandedAt, "ctrl+o did not append an expansion").toBeGreaterThan(0);
		expect(viewerAt, "ctrl+r did not open the viewer").toBeGreaterThan(0);
		// THE CROSSING, both directions. ctrl+o was pressed first and the
		// viewer must not be what answered it; ctrl+r came second and the
		// expansion must already have been on screen. One index comparison
		// carries both, because a key that reached the wrong handler would
		// land its surface on the wrong side of the other.
		expect(viewerAt, "the viewer opened at or before ctrl+o — a key reached the wrong handler").toBeGreaterThan(expandedAt);
	}, 90_000);

	it("neither ctrl+r press ran the expand chain", () => {
		// Counting the block in the byte stream proves nothing: every
		// frame repaints every row, so one appended block appears many
		// times on the wire (the tui-v7-expand gate moved to the screen
		// for exactly this reason). What IS repaint-immune is the expand
		// chain's own refusal: the session holds one fold, ctrl+o already
		// opened it, so a second trip through that chain has nothing left
		// and SAYS so. Neither notice may exist.
		const raw = transcript();
		expect(raw).not.toContain("nothing to expand");
		expect(raw).not.toContain("already the last thing on screen");
	}, 90_000);

	it("the settled card advertises the key that now opens it, and never the retired one", () => {
		const clean = transcript().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		expect(clean).toContain("ctrl+o");
		expect(clean).not.toMatch(/ctrl\+r expands/);
		expect(clean).not.toMatch(/ctrl\+r collapses/);
	}, 90_000);
});
