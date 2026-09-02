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
import { interactivePrompt, projectTrustRows, projectTrustView, projectUntrustedNote, unansweredAskView, uncertainView, verifyOfferView } from "../src/strings.js";

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
		// DECLARED SUPERSESSION (R2, design §4): the pending mark was `▸`,
		// which is also the checklist's "the current one". A panel waiting
		// on a human says `❯` — the one mark that means "nothing moves
		// until you answer". The 867a0fa literals are otherwise intact.
		expect(view.statusText).toBe("❯ project trust");
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
		expect(view.statusText).toBe("❯ uncertain execution");
		expect(view.args).toEqual({ kind: "text", lines: ["exec-7"] });
		// MOVED (the TUI2-R3v2 panel-selection supersession class): the
		// option labels left the rule line for the option ROWS. Copy that
		// names a digit it does not own goes stale the moment the digits
		// move, and this round moved them.
		//
		// DECLARED SUPERSESSION (RD1B-F1, 2026-08-24): the 867a0fa literal
		// asked the STATE ("did it apply?") and the dock-less path answers
		// it with an ACTION mapping — y → allow → rerun. A human who read
		// the workspace and answered truthfully re-ran an effect that had
		// already applied (RD-1B C3, both runs). Both questions name the
		// action now. This is the one field whose 867a0fa byte is
		// deliberately NOT preserved; every other byte still is.
		expect(view.ruleOverride).toBe("an interrupted execution may have applied — rerun it?");
		expect(view.simpleOptions).toEqual(["rerun it", "abandon it"]);
		expect(view.fallbackQuestion).toBe("interrupted execution: shell (exec-7) — rerun it? (y)es / (n)o ");
	});

	it("the fallback question ESCAPES the tool name — it reaches the terminal as raw text there", () => {
		// 867a0fa: escapeTerminal(uncertain.name) — an ESC in the name can
		// never become a control sequence in the dock-less question.
		const view = uncertainView("sh\x1b[31mell", "exec-7");
		expect(view.fallbackQuestion).toBe("interrupted execution: sh[31mell (exec-7) — rerun it? (y)es / (n)o ");
		// the TITLE is not pre-escaped — the panel renderer escapes its own
		// rows (the 867a0fa behavior, unchanged by the move)
		expect(view.title).toBe("sh\x1b[31mell (exec-7)");
	});
});

/**
 * RD1B-F1 — the dock-less answer-inversion gate.
 *
 * RD-1B's C3 (the classic double-deploy trap) failed both runs, and the
 * cause was NOT the benchmark's human surrogate: it was this copy. The
 * dock-less fallback asked a STATE question — "did it apply?" — while
 * askPanel maps `y` to `allow` and resolveUncertains maps `allow` to
 * `rerun`. A human who reads the workspace, sees deploy-output.txt, and
 * answers the question TRUTHFULLY ("yes, it applied") gets the effect
 * run a SECOND time. The other direction loses the work: "no, it did not
 * apply" resolves to `abandoned`.
 *
 * The invariant that catches this class for every simple view: the
 * dock-less question must name the action `y` PERFORMS — which is
 * exactly `simpleOptions[0]`, the option the dock puts on the allow row.
 * Three of the four views already satisfied it (verifyOfferView,
 * unansweredAskView, and this one after the fix); uncertainView was the
 * lone violator, which is what makes it an oversight rather than a
 * design.
 */
describe("RD1B-F1: a dock-less y/n question names the action `y` performs", () => {
	it("every simple view's fallback question contains its allow-row option", () => {
		const views = [
			{ label: "verifyOfferView", view: verifyOfferView() },
			{ label: "uncertainView", view: uncertainView("shell", "exec-7") },
			{ label: "unansweredAskView", view: unansweredAskView("exec-7") },
		];
		for (const { label, view } of views) {
			if (!view.simpleOptions) continue;
			const allowRow = view.simpleOptions[0];
			expect(view.fallbackQuestion?.toLowerCase(), `${label}: the y/n question must name "${allowRow}" — the action y performs`).toContain(allowRow.toLowerCase());
		}
	});

	it("uncertainView specifically: the question is the ACTION, never the state", () => {
		const view = uncertainView("deploy.sh", "ex-60");
		// The state question is the bug: answering it truthfully double-deploys.
		expect(view.fallbackQuestion).not.toContain("did it apply?");
		expect(view.fallbackQuestion).toContain("rerun it?");
	});
});
