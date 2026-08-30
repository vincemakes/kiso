#!/usr/bin/env tsx
/**
 * kiso TUI v10 — THE STANDING ACT SLOT, as frames you can look at.
 *
 * The difference from the v9 page: these frames are not written by
 * hand. They are driven through the REAL compositor and read back off
 * a real terminal cell model, so a frame here cannot say something the
 * product does not. v9's review caught hand-written live rows that had
 * drifted from the settled vocabulary (`running 4 shells` — verbatim
 * the defect the previous round had just removed); one page that
 * cannot drift is the answer to that class.
 *
 *   npx tsx scripts/tui-v10-preview.ts              # the arc, your width
 *   npx tsx scripts/tui-v10-preview.ts --width 52   # the narrow check
 *   npx tsx scripts/tui-v10-preview.ts --plain      # zero SGR — the pipe contract
 *   npx tsx scripts/tui-v10-preview.ts --check      # the self-proof, exit 1 on failure
 *
 * --check asserts three things about the arc:
 *   ① every emitted row is ONE physical row, no wider than W;
 *   ② the live region's height is IDENTICAL in every frame of a
 *     stretch — which is the round's whole claim, mechanically;
 *   ③ no settled fold row advertises a key (R4a).
 */

import { Body } from "../packages/tui/src/compositor.js";
import { Screen } from "../packages/tui/tests/helpers/screen.js";

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const PLAIN = argv.includes("--plain") || process.env.NO_COLOR !== undefined;
const wIdx = argv.indexOf("--width");
const W = Math.max(40, Math.min(120, wIdx >= 0 ? Number(argv[wIdx + 1]) : (process.stdout.columns || 88)));
const H = 22;

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Shot {
	title: string;
	note: string;
	rows: string[];
	live: number;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

async function run(): Promise<Shot[]> {
	const shots: Shot[] = [];
	const writes: string[] = [];
	(process.stdout as unknown as { isTTY: boolean }).isTTY = true;
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s: string) => writes.push(s) });
	const snap = async (title: string, note: string): Promise<void> => {
		await settle(); // the compositor coalesces frames at 16ms — let one land
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		shots.push({ title, note, rows: s.rows.map((r) => r.join("").replace(/\s+$/, "")), live: body.liveCount() });
	};
	body.enter();
	body.userLine("why does the CI job fail but not my machine");

	body.thinkingAppend("the failing job pulls the rollup native binary in the CI-only verify step");
	await snap("1 · thinking", "Before any call the slot holds the thinking that is producing them. R3i ruled that thinking belongs in the act window and then built no window for the thinking phase to live in; this is that ruling, wired.");

	body.toolStart("shell", "s1", { command: "npm run check" });
	body.toolRunning("s1");
	body.toolResult("s1", { content: "tui-cells 94 passed\ntui 181 passed\n275 passed", isError: false });
	await snap("2 · the gap between two calls", "THE FRAME THIS ROUND EXISTS FOR. 0.17.0 collapsed here to two rows and then grew again on the next call — the jump. The slot keeps the call that just finished, and its output, until something replaces it.");

	body.toolStart("read_file", "r1", { path: "packages/tui/src/compositor.ts" });
	body.toolRunning("r1");
	await snap("3 · the next call, in the same rows", "Contents swapped, rows unmoved. Nothing above this block has scrolled.");

	body.toolStart("read_file", "r2", { path: "packages/tui/src/editor.ts" });
	body.toolRunning("r2");
	body.toolStart("read_file", "r3", { path: "packages/tui-cells/src/components.ts" });
	body.toolRunning("r3");
	await snap("4 · three calls at once", "A parallel burst costs one head row each inside the same slot. In 0.17.0 this frame was up to seventeen rows — the biggest single jump on the screen.");

	body.toolResult("r1", { content: "ok", isError: false });
	body.toolResult("r2", { content: "ok", isError: false });
	body.toolResult("r3", { content: "ok", isError: false });
	body.textAppend("The rollup binary is an optional platform package the lockfile never installs on a clean runner.\n");
	body.textEnd();
	await snap("5 · the settle", "The prose closes the stretch. The six live rows become ONE committed row, with no key printed on it — the reference implementation's row is clean too, and its expansion lives in a mode you enter. The eye lands on the new prose, which is where the next thing to read is.");
	return shots;
}

const shots = await run();

if (CHECK) {
	const fails: string[] = [];
	for (const shot of shots) {
		for (const row of shot.rows) {
			if (strip(row).length > W) fails.push(`${shot.title}: row wider than W=${W}: ${JSON.stringify(strip(row))}`);
			if (row.includes("\n") || row.includes("\r")) fails.push(`${shot.title}: row contains a newline`);
		}
	}
	// ② the arc's live height NEVER moves (frames 1..4 — the open stretch)
	const open = shots.slice(0, 4).map((s) => s.live);
	if (new Set(open).size !== 1) fails.push(`the live height MOVED across the open stretch: ${open.join(" → ")}`);
	// ③ R4a — the settled fold prints NO key. Its words are the row.
	const settled = shots[shots.length - 1]!.rows.join("\n");
	for (const row of strip(settled).split("\n").map((r) => r.trim())) {
		if (row.startsWith("✦ ") && !row.startsWith("✦ took") && row.includes("ctrl+r")) fails.push(`a fold row still advertises a key: ${row}`);
	}
	if (fails.length > 0) {
		for (const f of fails) console.error(`FAIL  ${f}`);
		process.exit(1);
	}
	console.log(`[tui-v10] OK at W=${W} — ${shots.length} frames, every row one row, the open stretch held ${open[0]} live rows throughout, no fold row advertises a key.`);
	process.exit(0);
}

for (const shot of shots) {
	const hdr = `${shot.title}  ${"─".repeat(Math.max(0, W - shot.title.length - 2))}`;
	console.log(PLAIN ? `\n${hdr}` : `\n\x1b[1m${hdr}\x1b[0m`);
	console.log(PLAIN ? `${shot.note}\n` : `\x1b[2m${shot.note}\x1b[0m\n`);
	for (const row of shot.rows) console.log(PLAIN ? strip(row) : row);
	console.log(PLAIN ? `   [live rows: ${shot.live}]` : `\x1b[2m   [live rows: ${shot.live}]\x1b[0m`);
}
