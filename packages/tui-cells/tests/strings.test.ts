/**
 * KC3 slice 1 — the extraction's ZERO-BEHAVIOR proof.
 *
 * Every expectation below is the literal the CLI's trust-ui.ts built
 * inline at 867a0fa, transcribed by hand from that revision — NOT
 * re-derived from the moved code (a test written against the new
 * implementation would prove only that it equals itself). A byte that
 * changed in the move fails here.
 *
 * The one difference the move makes visible rather than unifying: the
 * project-trust listing's INDENT. The scrollback record indented two,
 * the panel's args did not; both callers now reach the same function
 * with the indent as its parameter, and both bytes are pinned.
 */

import { afterEach, describe, expect, it } from "vitest";
import { COLOR_OFF, COLOR_ON } from "../src/render.js";
import { interactivePrompt, projectTrustRows, projectTrustView, projectUntrustedNote, uncertainView } from "../src/strings.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => {
	delete process.env.NO_COLOR;
	setTTY(ORIG_TTY ?? false);
});

const FILES = [
	{ path: "mcp.json", digest: "abcdef0123456789" },
	{ path: "skills/review/SKILL.md", digest: "0123456789abcdef" },
];

describe("KC3 §1: interactivePrompt — the readline prompt, byte-for-byte", () => {
	it("a TTY without NO_COLOR: the bold identity accent around `you> `", () => {
		delete process.env.NO_COLOR;
		setTTY(true);
		// 867a0fa trust-ui.ts: `${p.bold}you> ${p.reset}`
		expect(interactivePrompt()).toBe(`${COLOR_ON.bold}you> ${COLOR_ON.reset}`);
	});

	it("NO_COLOR / a pipe: the bare `you> ` — pipe bytes are unchanged", () => {
		process.env.NO_COLOR = "1";
		setTTY(true);
		expect(interactivePrompt()).toBe("you> ");
		expect(COLOR_OFF.bold).toBe("");
	});
});

describe("KC3 §1: the project-trust listing rows", () => {
	it("the panel's args carry NO indent — the block's frame supplies the inset", () => {
		// 867a0fa: artifacts.files.map((f) => `${f.path}  (${f.digest.slice(0, 6)})`)
		expect(projectTrustRows(FILES)).toEqual(["mcp.json  (abcdef)", "skills/review/SKILL.md  (012345)"]);
	});

	it("the scrollback record indents two — it sits under the root's own line", () => {
		// 867a0fa: bodyLog(`  ${f.path}  (${f.digest.slice(0, 6)})`)
		expect(projectTrustRows(FILES, "  ")).toEqual(["  mcp.json  (abcdef)", "  skills/review/SKILL.md  (012345)"]);
	});

	it("the digest is cut to SIX characters, never the whole hash", () => {
		expect(projectTrustRows([{ path: "a", digest: "0123456789" }])).toEqual(["a  (012345)"]);
	});

	it("no artifacts — no rows", () => {
		expect(projectTrustRows([])).toEqual([]);
	});
});

describe("KC3 §1: projectTrustView — the trust gate's panel", () => {
	it("every field is the 867a0fa literal", () => {
		const view = projectTrustView("/repo/.kiso", FILES);
		expect(view.flavor).toBe("simple");
		expect(view.name).toBe("project trust");
		expect(view.title).toBe("/repo/.kiso");
		expect(view.speaker).toBe("kiso");
		expect(view.statusText).toBe("▸ project trust");
		expect(view.ruleOverride).toBe("trust this project's .kiso?");
		expect(view.fallbackQuestion).toBe("trust this project's .kiso? (y/n) ");
		expect(view.args).toEqual({ kind: "text", lines: ["mcp.json  (abcdef)", "skills/review/SKILL.md  (012345)"] });
	});

	it("the SIMPLE flavor is load-bearing: a project has no per-tool `don't ask again` rule", () => {
		expect(projectTrustView("/repo/.kiso", []).flavor).toBe("simple");
		expect(projectTrustView("/repo/.kiso", []).hint).toBeUndefined();
	});
});

describe("KC3 §1: projectUntrustedNote — the non-TTY note", () => {
	it("the 867a0fa sentence, with the count and the root", () => {
		expect(projectUntrustedNote(2, "/repo/.kiso")).toBe(
			"[project .kiso] found 2 artifact(s) in /repo/.kiso — not trusted, not loaded (run kiso interactively once to decide)",
		);
	});

	it("the `(s)` is deliberately not pluralized — one artifact reads the same way", () => {
		expect(projectUntrustedNote(1, "/x")).toBe("[project .kiso] found 1 artifact(s) in /x — not trusted, not loaded (run kiso interactively once to decide)");
	});
});

describe("KC3 §1: uncertainView — the uncertain execution's panel", () => {
	it("every field is the 867a0fa literal", () => {
		const view = uncertainView("shell", "exec-7");
		expect(view.flavor).toBe("simple");
		expect(view.name).toBe("uncertain execution");
		expect(view.title).toBe("shell (exec-7)");
		expect(view.speaker).toBe("kiso");
		expect(view.statusText).toBe("▸ uncertain execution");
		expect(view.args).toEqual({ kind: "text", lines: ["exec-7"] });
		// MOVED (the TUI2-R3v2 panel-selection supersession class): the
		// option labels left the rule line for the option ROWS. Copy that
		// names a digit it does not own goes stale the moment the digits
		// move, and this round moved them.
		expect(view.ruleOverride).toBe("did the interrupted execution apply?");
		expect(view.simpleOptions).toEqual(["rerun it", "abandon it"]);
		expect(view.fallbackQuestion).toBe("⚠ interrupted execution: shell (exec-7) — did it apply? (y)es / (n)o ");
	});

	it("the fallback question ESCAPES the tool name — it reaches the terminal as raw text there", () => {
		// 867a0fa: escapeTerminal(uncertain.name) — an ESC in the name can
		// never become a control sequence in the dock-less question.
		const view = uncertainView("sh\x1b[31mell", "exec-7");
		expect(view.fallbackQuestion).toBe("⚠ interrupted execution: sh[31mell (exec-7) — did it apply? (y)es / (n)o ");
		// the TITLE is not pre-escaped — the panel renderer escapes its own
		// rows (the 867a0fa behavior, unchanged by the move)
		expect(view.title).toBe("sh\x1b[31mell (exec-7)");
	});
});
