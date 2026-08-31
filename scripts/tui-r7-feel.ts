#!/usr/bin/env tsx
/**
 * R7 — feel it. The REAL compositor, in your terminal, at real pace.
 *
 * Not a preview: this constructs the product's own Body, writes its
 * actual bytes to your stdout, and streams a realistic turn through it
 * with the timing a model would have. What you see is what kiso does.
 *
 * The turn is built to show the round's whole point in one arc:
 *   think → ONE shell → think → a BURST of four → think → the answer
 *
 * Watch for three things:
 *   1. the single call keeps its command verbatim and never folds
 *   2. the burst folds to one row
 *   3. `thought Ns` is gone from that row — nothing deleted it; the
 *      segment's thinking clock never starts now, so R3h's own
 *      zero-term rule drops it
 *
 *   npx tsx scripts/tui-r7-feel.ts            # real pace
 *   npx tsx scripts/tui-r7-feel.ts --fast     # 4x
 *   npx tsx scripts/tui-r7-feel.ts --slow     # half speed
 */
import { Body } from "../packages/tui/src/compositor.js";

const argv = process.argv.slice(2);
const RATE = argv.includes("--fast") ? 0.25 : argv.includes("--slow") ? 2 : 1;
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms * RATE));
/** type a paragraph the way a model streams it */
async function stream(fn: (s: string) => void, text: string, per = 14): Promise<void> {
	for (const word of text.split(/(?<= )/)) {
		fn(word);
		await nap(per);
	}
}

if (process.stdout.isTTY !== true) {
	console.error("run this in a real terminal — it paints with escape codes");
	process.exit(1);
}

const body = new Body({
	active: () => true,
	height: () => process.stdout.rows ?? 24,
	width: () => process.stdout.columns ?? 80,
	editCol: () => 1,
	write: (s: string) => process.stdout.write(s),
});

async function main(): Promise<void> {
	body.enter();
	await nap(300);
	body.userLine("why does the CI job fail but not on my machine");
	await nap(500);

	// ── stretch 1: think, then ONE shell ──────────────────────────────
	await stream((t) => body.thinkingAppend(t), "The failing job pulls the rollup native binary in the CI-only verify step. Let me run the check locally first and see whether it reproduces. ");
	body.thinkingEnd();
	await nap(250);
	body.toolStart("shell", "s1", { command: "npm run check" });
	body.toolRunning("s1");
	// (the running shell's live tail comes from a sidecar file the real
	// CLI writes; a synthetic driver has none, so the block shows its
	// "waiting for output" form until the result lands — the shape is
	// real, the tail is the one thing this script cannot fake)
	await nap(1600);
	body.toolResult("s1", { content: "tui-cells 94 passed\ntui 181 passed\n275 passed", isError: false });
	await nap(350);

	// ── stretch 2: think, then a BURST ────────────────────────────────
	await stream((t) => body.thinkingAppend(t), "It passes here, so the difference is the runner, not the code. Reading the lockfile and the workflow together. ");
	body.thinkingEnd();
	await nap(250);
	const burst = ["package-lock.json", "packages/tui/package.json", ".github/workflows/ci.yml", "packages/runtime/package.json"];
	for (const [i, path] of burst.entries()) {
		body.toolStart("read_file", `r${i}`, { path });
		body.toolRunning(`r${i}`);
		await nap(180);
	}
	for (const [i] of burst.entries()) {
		await nap(300);
		body.toolResult(`r${i}`, { content: "…", isError: false });
	}
	await nap(350);

	// ── stretch 3: think, then the answer ─────────────────────────────
	await stream((t) => body.thinkingAppend(t), "The lockfile has the linux entry but npm never installs the optional platform package on a clean runner. ");
	body.thinkingEnd();
	await nap(250);
	await stream((t) => body.textAppend(t), "The rollup binary is an optional platform package: the lockfile carries it, and a clean Linux runner never installs it. build and typecheck pass because neither loads rollup; only vitest does.\n", 22);
	body.textEnd();
	await nap(300);
	body.endTurn(41);
	await nap(900);
	body.exit();
	process.stdout.write("\n");
	console.log("\x1b[2m  ── what just happened ─────────────────────────────────\x1b[0m");
	console.log("\x1b[2m  the single shell kept its command and never folded\x1b[0m");
	console.log("\x1b[2m  the burst of four folded to one row\x1b[0m");
	console.log("\x1b[2m  and that row carries no `thought Ns` — nothing removed it\x1b[0m");
	console.log("\x1b[2m  (the byte form is still the OLD one-line thinking fold;\x1b[0m");
	console.log("\x1b[2m   italic + 2-space paragraphs are the next step)\x1b[0m");
}
main().catch((e: unknown) => {
	body.exit();
	console.error(e);
	process.exit(1);
});
