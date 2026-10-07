/**
 * Graphite P4 — the approval and question panels on a real pty (owner,
 * 2026-10-04). The unit file (packages/tui/tests/graphite-approval-panels)
 * pins the band's shape; this one pins what the real binary puts on screen
 * while a run waits: the band names who asked, the call is said once as its
 * card's head, the key row says esc denies, the Graphite bar stays under the
 * panel, and no old lead (`pick>`, `amend›`) or old status row comes back.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const RISKY = { type: "tool_call_end", callId: "r1", name: "shell", input: { command: "rm -rf build && npm run build" } };
const QUESTIONS = [
	{ question: "which bundler?", header: "bundler", options: [{ label: "vite", description: "fast dev server" }, { label: "esbuild", description: "one binary" }] },
	{ question: "which test runners?", header: "runners", multiSelect: true, options: [{ label: "vitest" }, { label: "node:test" }] },
];

describe("Graphite P4 — an approval on a real pty", () => {
	it("the band names who asked, the call is said once, the note row has its hint — and the bar stays under it", () => {
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Cleaning and rebuilding." }, RISKY, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "stopped there." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "p4-approval"], env as NodeJS.ProcessEnv, {
			// the driver fires each needle the first time it appears anywhere, so
			// every needle here is one only the key before it can bring on screen
			feeds: [
				["▌ ", "clean and rebuild\r"],
				["needs you · asked by", "4"], // the 4th option: tell it what to do instead
				["tell kiso what to do instead", "keep build/\r"], // the note row's hint is up: write the note
				["stopped there.", "exit\r"],
			],
		});
		const t = plain(raw);
		const open = t.slice(t.indexOf("needs you · asked by"));
		expect(open).toContain("needs you · asked by mode:default");
		expect(open).toContain("SHELL rm -rf build && npm run build");
		expect(open, "the one-line command is not repeated in a body").not.toContain("│ rm -rf build");
		expect(open).toContain("deletes files permanently (build)");
		expect(open).toMatch(/1–4 instant · esc denies +\d\/4/);
		expect(open).toContain("your note goes to the model — it will propose a new call");
		expect(open, "the bar stays under the panel").toContain("/mode to switch");
		expect(open).not.toContain("run paused");
		expect(open).not.toContain("amend›");
		expect(open).not.toContain("/ commands · ↑ history");
	}, 120_000);
});

describe("Graphite P4 — the model's question on a real pty", () => {
	it("the band carries the header and the place in the set; no `pick>`, no status sentence", () => {
		const script = fauxScript([
			{ events: [{ type: "tool_call_end", callId: "q1", name: "ask_user", input: { questions: QUESTIONS } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "noted." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "p4-question"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "set the project up\r"],
				["question · bundler · 1 of 2", "1"],
				["question · runners · 2 of 2 · pick any", " \r"],
				["noted.", "exit\r"],
			],
		});
		const t = plain(raw);
		const open = t.slice(t.indexOf("question · bundler · 1 of 2"));
		expect(open).toContain("which bundler?");
		expect(open).toMatch(/1–2 instant · ⏎ confirms · t types · esc declines +1\/3/);
		expect(open).toContain("/mode to switch");
		expect(open).not.toContain("pick>");
		expect(open).not.toContain("answers are durable facts");
		expect(open).not.toContain("‹ 1/2 ›");
	}, 120_000);
});
