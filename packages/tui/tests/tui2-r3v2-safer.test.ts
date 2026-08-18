/**
 * TUI2-R3v2 slice ③ — "show me safer ways to do this", at the editor.
 *
 * Option 3 is the round's one new model request, and everything about
 * its shape here is about keeping that request HONEST:
 *
 *  - it fires only when pressed (the zero-ambient-rent claim is a
 *    property of this branch and nowhere else);
 *  - while it is in flight the panel says so, because a button that
 *    goes quiet for two seconds reads as broken;
 *  - a failure degrades to ONE dim line and puts every original choice
 *    back, because the alternative — a spinner that never resolves, or
 *    a fabricated list — is worse than not having asked;
 *  - the pick routes through the EXISTING amend channel. Choosing a
 *    safer command is a denial with instructions, which is a verdict
 *    the product already has. Inventing a fifth verdict for it would
 *    have put a new shape into the durable approval contract for a
 *    render-side convenience.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import type { PanelVerdict, PanelView, SaferOption } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);
const DOWN = enc("\x1b[B");
const tick = () => new Promise((r) => setTimeout(r, 0));

const view: PanelView = {
	flavor: "approval",
	name: "shell",
	title: "shell rm -rf build",
	speaker: "mode:default",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["rm -rf build && npm run build"] },
	fallbackQuestion: "approve shell? (y/n) ",
};

const ALTS: SaferOption[] = [
	{ command: "npm run build", why: "rebuild in place, keep build/" },
	{ command: "rm -rf build/cache && npm run build", why: "only clear the cache" },
];

function open(safer?: () => Promise<readonly SaferOption[] | null>) {
	const editor = new Editor(() => {});
	let got: PanelVerdict | null = null;
	editor.beginPanel(view, (v) => (got = v), safer === undefined ? undefined : { safer });
	return { editor, verdict: () => got };
}

describe("TUI2-R3v2 ③ — the safer-options round trip", () => {
	it("ZERO AMBIENT RENT: the provider is not called unless 3 is pressed", async () => {
		let calls = 0;
		const { editor } = open(async () => {
			calls += 1;
			return ALTS;
		});
		editor.feed(enc("\x1b[B")); // move about
		editor.feed(enc("\x1b[A"));
		editor.feed(enc("1")); // approve, never asking
		await tick();
		expect(calls, "a session that never presses 3 makes no request").toBe(0);
	});

	it("pressing 3 asks ONCE, and the panel says it is asking", async () => {
		let calls = 0;
		const { editor } = open(async () => {
			calls += 1;
			return ALTS;
		});
		editor.feed(enc("3"));
		expect(editor.panelState()?.phase, "the in-flight state is visible").toBe("asking");
		await tick();
		expect(calls).toBe(1);
		expect(editor.panelState()?.phase).toBe("safer");
	});

	it("the alternatives render as a LIST, with the way back as its last row", async () => {
		const { editor } = open(async () => ALTS);
		editor.feed(enc("3"));
		await tick();
		const safer = editor.panelState()?.safer;
		expect(safer?.options.map((o) => o.command)).toEqual(["npm run build", "rm -rf build/cache && npm run build"]);
		expect(safer?.cursor).toBe(0);
	});

	it("choosing one routes through the EXISTING amend channel — a denial with instructions", async () => {
		const { editor, verdict } = open(async () => ALTS);
		editor.feed(enc("3"));
		await tick();
		editor.feed(enc("1"));
		const v = verdict() as PanelVerdict | null;
		expect(v, "no new verdict shape — the amend channel carries it").not.toBeNull();
		expect((v as { action: string }).action).toBe("deny");
		expect((v as { reason: string }).reason).toContain("npm run build");
	});

	it("the second alternative is reachable by ↑↓ and by its digit", async () => {
		const byArrow = open(async () => ALTS);
		byArrow.editor.feed(enc("3"));
		await tick();
		byArrow.editor.feed(DOWN);
		expect(byArrow.editor.panelState()?.safer?.cursor).toBe(1);
		byArrow.editor.feed(enc("\r"));
		expect((byArrow.verdict() as { reason: string }).reason).toContain("build/cache");

		const byDigit = open(async () => ALTS);
		byDigit.editor.feed(enc("3"));
		await tick();
		byDigit.editor.feed(enc("2"));
		expect((byDigit.verdict() as { reason: string }).reason).toContain("build/cache");
	});

	it("the LAST row goes back to the original choices — nothing is decided", async () => {
		const { editor, verdict } = open(async () => ALTS);
		editor.feed(enc("3"));
		await tick();
		editor.feed(enc("3")); // 2 alternatives + the way back = row 3
		expect(verdict()).toBeNull();
		expect(editor.panelState()?.phase).toBe("options");
		expect(editor.panelState()?.cursor).toBe(0);
	});

	it("esc backs out of the safer list the same way", async () => {
		const { editor, verdict } = open(async () => ALTS);
		editor.feed(enc("3"));
		await tick();
		editor.feed(enc("\x1b"));
		expect(verdict()).toBeNull();
		expect(editor.panelState()?.phase).toBe("options");
	});

	it("a FAILED ask degrades honestly — one dim line, every original choice intact", async () => {
		const { editor, verdict } = open(async () => {
			throw new Error("provider exploded");
		});
		editor.feed(enc("3"));
		await tick();
		expect(verdict(), "a failure never decides anything").toBeNull();
		expect(editor.panelState()?.phase).toBe("options");
		expect(editor.panelState()?.note).toBe("couldn't get safer options — the original choices stand");
		editor.feed(enc("1")); // the original choices still work
		expect((verdict() as { action: string }).action).toBe("allow");
	});

	it("an EMPTY or unparseable answer degrades the same way — never an empty list", async () => {
		for (const bad of [null, [] as SaferOption[]]) {
			const { editor } = open(async () => bad);
			editor.feed(enc("3"));
			await tick();
			expect(editor.panelState()?.phase, JSON.stringify(bad)).toBe("options");
			expect(editor.panelState()?.note).toBe("couldn't get safer options — the original choices stand");
		}
	});

	it("with NO provider bound the button degrades rather than lying", async () => {
		const { editor } = open(); // no safer provider at all
		editor.feed(enc("3"));
		await tick();
		expect(editor.panelState()?.phase).toBe("options");
		expect(editor.panelState()?.note).toBe("couldn't get safer options — the original choices stand");
	});

	it("a panel CANCELLED mid-flight never resurrects itself when the answer lands", async () => {
		let resolve!: (v: readonly SaferOption[] | null) => void;
		const { editor, verdict } = open(() => new Promise((r) => (resolve = r)));
		editor.feed(enc("3"));
		expect(editor.panelState()?.phase).toBe("asking");
		editor.cancelPanel();
		expect((verdict() as { action: string }).action).toBe("cancel");
		resolve(ALTS); // the late answer
		await tick();
		expect(editor.panelState(), "a closed panel stays closed").toBeNull();
	});
});
