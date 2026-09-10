/**
 * TPS-1 — the decode rate reaches the status row, and leaves it when it
 * should.
 *
 * REAL kiso chat under a pty, faux provider. The faux adapter already has
 * both pieces this needs and neither had to be built: a `usage` event
 * (FauxTurn.events takes EventInput, and Usage is a member of the Event
 * union), and `delay`, which awaits REAL milliseconds mid-stream so the
 * decode window is a known quantity rather than whatever the machine did.
 *
 * The arithmetic is pinned exactly in the unit gates. Here the assertion
 * is a BAND, on purpose: this is a pty on a machine that may be busy, and
 * a timing gate that demands an exact integer is a gate that goes red for
 * the runner's reasons and teaches the reader to ignore it.
 *
 * The three negative legs are the ones that carry the round's weight. The
 * under-the-floor leg is also the regression gate for every OTHER
 * faux-driven test in the suite: a script with no delay streams instantly,
 * lands under half a second, renders nothing, and those rows stay exactly
 * as they were.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, screenAt, spares } from "./helpers/pty.js";

// DF-0330-F1: the idle row is found by its TIER MARKER, not by the /mode
// hint — the hint is the first thing the drop order gives up, so a needle
// on it silently finds nothing at exactly the widths worth testing. (This
// helper keyed on the hint until the narrow-width leg went red on an empty
// string rather than on a missing rate.)
const statusRowOf = (screen: string[]): string => screen.find((row) => row.trimStart().startsWith("▸ ")) ?? "";
const rateOn = (row: string): number | null => {
	const m = /· (\d+) tok\/s/.exec(row);
	return m === null ? null : Number(m[1]);
};

const home = (dirs: { home: string }, model = "deepseek-v4-flash"): void => {
	writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify({ models: { ds: { kind: "openai-compat", model, apiKeyEnv: "MY_TEST_KEY" } } })}\n`);
};

/** DF-0330-F1 — the owner's OWN model id, and the reason that finding
 *  exists. Thirty-five columns where this suite's fixture had seventeen: a
 *  fixture comfortably shorter than reality tests a world with more room in
 *  it than the one the product ships into. */
const LONG_ID = "deepseek-v4.1-flash-expires-on-0910";

describe("TPS-1 — the settled decode rate on the status row", () => {
	it("a call that decoded for a known window paints a rate; /model clears it", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{
					events: [
						{ type: "text_delta", text: "one." },
						// the decode window: real milliseconds between the first
						// streamed event and the usage that closes the call
						{ type: "delay", ms: 1500 },
						{ type: "usage", inputTokens: 100, outputTokens: 120, cacheRead: null, cacheWrite: null, known: true },
						{ type: "stop", reason: "end_turn" },
					],
				},
				...spares(4),
			]),
			MY_TEST_KEY: "sk-fake",
		});
		home(dirs);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-tps1-"));
		const raw = ptyRun(["chat", "tps1-rate"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["tok/s", "/model ds max\r"],
				["takes effect on the next turn", "exit\r"],
			],
			timeout: 60,
		});

		const settled = statusRowOf(screenAt(raw, "tok/s"));
		const rate = rateOn(settled);
		expect(rate, `no rate on the settled row: ${settled}`).not.toBeNull();
		// 120 tokens over ~1.5s of decoding is ~80/s; the band is wide because
		// the exact number is the unit gates' job, not this one's.
		expect(rate).toBeGreaterThan(20);
		expect(rate).toBeLessThan(200);
		// the segment comes after the ctx estimate — not anchored to the end of
		// the line, because the dock's row carries the affordance hint to its
		// right and an end-anchor would be asserting the hint, not the order.
		expect(settled).toMatch(/ctx left ~\d+% · \d+ tok\/s/);

		// the switch's own frame: a new binding has no measurement
		const after = statusRowOf(screenAt(raw, "takes effect on the next turn"));
		expect(after, "the row did not repaint with the new model").toContain("deepseek-v4-flash · max");
		expect(after, "the previous binding's rate survived the switch").not.toContain("tok/s");
	}, 120_000);

	it("a provider that reports no usage paints no rate — an unmeasured call is not a slow one", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{
					events: [
						{ type: "text_delta", text: "one." },
						{ type: "delay", ms: 1500 },
						{ type: "usage", inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null, known: false },
						{ type: "stop", reason: "end_turn" },
					],
				},
				...spares(4),
			]),
			MY_TEST_KEY: "sk-fake",
		});
		home(dirs);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-tps1-unknown-"));
		const raw = ptyRun(["chat", "tps1-unknown"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["took ", "exit\r"],
			],
			timeout: 60,
		});
		expect(raw, "a rate appeared for a call that reported no usage").not.toContain("tok/s");
	}, 120_000);

	it("an instant call is under the floor and paints nothing — every other faux test's row is unchanged", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{
					events: [
						{ type: "text_delta", text: "one." },
						// no delay: the whole call is microseconds
						{ type: "usage", inputTokens: 100, outputTokens: 120, cacheRead: null, cacheWrite: null, known: true },
						{ type: "stop", reason: "end_turn" },
					],
				},
				...spares(4),
			]),
			MY_TEST_KEY: "sk-fake",
		});
		home(dirs);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-tps1-instant-"));
		const raw = ptyRun(["chat", "tps1-instant"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["took ", "exit\r"],
			],
			timeout: 60,
		});
		expect(raw, "an instant call was given a rate").not.toContain("tok/s");
	}, 120_000);
	it("times each CALL from its own first event — a turn's second call replaces the first's rate", () => {
		// The "per CALL, not per turn" claim, end to end. Two model calls in
		// ONE user turn, with decode windows chosen so the two rates cannot be
		// confused: 120 tokens over ~1.5s is ~80/s, then 30 over ~3s is ~10/s.
		// If the clock were armed per TURN, the second call would be timed from
		// the first call's first event (~4.5s → ~33/s) and the row would not
		// land near 10.
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{
					events: [
						{ type: "text_delta", text: "looking." },
						{ type: "delay", ms: 1500 },
						{ type: "usage", inputTokens: 100, outputTokens: 120, cacheRead: null, cacheWrite: null, known: true },
						{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{
					events: [
						{ type: "text_delta", text: "done." },
						{ type: "delay", ms: 3000 },
						{ type: "usage", inputTokens: 100, outputTokens: 30, cacheRead: null, cacheWrite: null, known: true },
						{ type: "stop", reason: "end_turn" },
					],
				},
				...spares(4),
			]),
			MY_TEST_KEY: "sk-fake",
		});
		home(dirs);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-tps1-twocall-"));
		const raw = ptyRun(["chat", "tps1-twocall"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["took ", "exit\r"],
			],
			timeout: 90,
		});
		const settled = statusRowOf(screenAt(raw, "took "));
		const rate = rateOn(settled);
		expect(rate, `no rate on the settled row: ${settled}`).not.toBeNull();
		// the SECOND call's rate, not the first's and not a turn-wide average
		expect(rate, "the row carries the first call's rate — the clock is per turn, not per call").toBeLessThan(30);
		expect(rate).toBeGreaterThan(2);
	}, 150_000);
	it("DF-0330-F1 — the CLI hands the row its WIDTH: at 60 columns the hint goes and every fact stays", () => {
		// What this level proves, and the unit gates cannot: that the CLI
		// passes its terminal width to the formatter at all. Before the fix
		// the row was composed blind and invariant ① cut whatever sat last,
		// which is how a measured rate went missing at 100 columns with the
		// owner's 35-column model id.
		//
		// The id-length cases live in the unit gates (every length from 1 to
		// 40, with the owner's real id), because the faux session's label is
		// `faux` and no fixture can make it long. Here the WIDTH is the
		// variable instead: at 60 columns even the short label overflows, so
		// the drop order has to run end to end.
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{
					events: [
						{ type: "text_delta", text: "one." },
						{ type: "delay", ms: 1500 },
						{ type: "usage", inputTokens: 1000, outputTokens: 120, cacheRead: 900, cacheWrite: null, known: true },
						{ type: "stop", reason: "end_turn" },
					],
				},
				...spares(4),
			]),
			MY_TEST_KEY: "sk-fake",
		});
		home(dirs);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-tps1-narrow-"));
		const raw = ptyRun(["chat", "tps1-narrow"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			cols: 60,
			feeds: [
				["/ commands", "go\r"],
				["tok/s", "exit\r"],
			],
			timeout: 60,
		});
		const settled = statusRowOf(screenAt(raw, "tok/s"));
		// the FACTS all survive
		expect(rateOn(settled), `no rate on the row at 60 columns: ${settled}`).not.toBeNull();
		expect(settled).toContain("▸ default");
		expect(settled).toContain("CH ");
		expect(settled).toContain("ctx left");
		// and the teaching hint is what gave ground
		expect(settled, `the hint survived a row that had no room for it: ${settled}`).not.toContain("/mode to switch");
	}, 120_000);
});
