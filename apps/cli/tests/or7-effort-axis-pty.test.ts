/**
 * OR-7 — the model pick panel's SECOND axis (the coordination note of
 * 2026-09-08, `kiso-coord-model-picker-axis-2026-09-08.md`).
 *
 * `/model` could pick a profile and nothing else. The effort levels were
 * already ON the panel — the CLI half prints them in each row's note —
 * but they were text: the only way to choose one was to close the panel
 * and type `/model <profile> <effort>`. A level you can read and cannot
 * press is the defect DC-36 filed against the mode panel, one surface over.
 *
 * The axis: up/down walk the profiles as before, left/right walk the
 * HIGHLIGHTED profile's native levels, enter applies both through the one
 * path the typed command already uses — so the refusal wording and the
 * durable profile revision are that path's, not a second implementation.
 *
 * The keystrokes ride the WALL CLOCK, not a needle: the panel's status
 * text is written before its rows are, so a key fed the moment a needle
 * appears reaches a panel that has not finished painting (the R1.5
 * lesson, inherited whole — and re-learned here, which is why this note
 * is repeated rather than referenced).
 *
 * REAL kiso chat under a pty, faux provider. The switch target is never
 * asked anything: `/model` writes the durable profile revision without
 * sending a request, which is what lets this assert the bound value
 * without spending one.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun, settledScreen } from "./helpers/pty.js";

/** The transcript without its attributes. The ladder is bold around the
 *  bracketed cell, so the level text is only contiguous once the SGR
 *  runs are gone. */
const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("OR-7 — the pick panel's effort axis", () => {
	it("left/right walk the highlighted profile's levels; enter applies profile AND effort through the typed command's path", () => {
		const { env, dirs } = isolatedEnv();
		// Two profiles, in this order, so the DOWN arrow is exercised:
		//  - `plain` first: a model no registry knows, so the row has no
		//    levels and the axis must leave it alone;
		//  - `axis` second: claude-opus-5, whose row is the five-level
		//    ladder (low · medium · [high] · xhigh · max), default high.
		writeFileSync(
			join(dirs.home, "config.json"),
			`${JSON.stringify({
				models: {
					plain: { kind: "openai-compat", model: "no-such-model-in-any-registry", apiKeyEnv: "OR7_KEY", baseUrl: "http://127.0.0.1:9" },
					axis: { kind: "anthropic", model: "claude-opus-5", apiKeyEnv: "OR7_KEY" },
				},
			})}\n`,
		);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-or7-w-"));
		const raw = ptyRun(["chat", "axis-a"], { ...env, OR7_KEY: "fake" } as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "/model\r"],
				["takes effect on the next turn", "exit\r"],
			],
			// ↓ to `axis`, then two → up its ladder (high → xhigh → max),
			// then enter. Spaced so each lands on a painted panel.
			delays: [
				[2, "\x1b[B"],
				[2.6, "\x1b[C"],
				[3.0, "\x1b[C"],
				[3.6, "\r"],
			],
		});

		// ── the panel half. Asserted on the RAW stream, not a reconstructed
		// frame: the dock repaints by whole ROWS, so each ladder state is
		// written contiguously, while `screenAt` cuts at the marker's own
		// bytes and hands back a half-painted screen. ──
		expect(plain(raw), "the ladder opens on the model's own registry default").toContain("effort: low · medium · [high] · xhigh · max");
		expect(plain(raw), "the affordance names the new gesture").toContain("←→ effort");
		// the row without levels keeps its old shape
		expect(plain(raw)).toContain("openai-compat/no-such-model-in-any-registry");

		// ── the cursor WALKED, one visible step per press. This is the
		// contract's whole point: visible movement replaces silent
		// clamping, so each intermediate state has to reach the screen. ──
		expect(plain(raw), "the first right moved the bracket off the default").toContain("effort: low · medium · high · [xhigh] · max");
		expect(plain(raw), "the second right reached the top of the ladder").toContain("effort: low · medium · high · xhigh · [max]");

		// ── the notice: both axes, in the typed command's own wording ──
		expect(plain(raw), "the notice names both axes").toContain("model → axis (claude-opus-5 · max)");
		// the status row carries the applied level once the panel is gone
		expect(settledScreen(raw).join("\n"), "the row names the level it is bound to").toContain("claude-opus-5 · max");

		// ── the durable half: the session's own profile records the effort,
		// so a fresh process resumes bound to it ──
		const meta = JSON.parse(readFileSync(join(dirs.home, "sessions", "axis-a.meta.json"), "utf8")) as {
			profile: { modelId: string; revision: number; reasoning: { thinking: string; effort: string } };
		};
		expect(meta.profile.modelId).toBe("claude-opus-5");
		expect(meta.profile.reasoning.effort, "the effort is a durable fact, not a screen state").toBe("max");
		expect(meta.profile.revision).toBeGreaterThanOrEqual(2);
	}, 240_000);
});
