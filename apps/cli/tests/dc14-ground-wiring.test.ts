/**
 * DC-14 — the ground ladder is WALKED, not merely correct.
 *
 * `resolveGround` had a complete unit suite covering every rung and
 * every precedence rule, and passed. It had exactly ONE call site, and
 * that site was inside the OSC-11 reply callback — so on a terminal
 * that does not answer the query (tmux does not forward the reply by
 * default) no rung ran at all: `KISO_THEME`, which design.md §3 settles
 * as "an explicit answer always wins", won nothing, and `COLORFGBG` —
 * the rung that exists FOR terminals without OSC 11 — was reachable
 * only when a reply had arrived AND been malformed.
 *
 * A pure function with a complete test suite and one call site is only
 * as correct as its call site. This is the gate for the CALL, which is
 * what did not exist: it reads the SHIPPED entry point and demands that
 * the ladder be walked unconditionally at startup, before and
 * independently of the query.
 *
 * It is a source gate rather than a PTY one on purpose. The observable
 * effect needs a terminal that stays silent to an OSC 11, which is
 * precisely the environment a test harness cannot conjure — so the
 * assertion is about the wiring, at the only place the wiring exists.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGround } from "@vincemakes/kiso-tui";

const SRC = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");

/** the ladder's calls, in source order, each tagged with whether it sits
 *  inside the OSC-reply callback */
function groundCalls(): { insideOscCallback: boolean; passesOsc: boolean }[] {
	const out: { insideOscCallback: boolean; passesOsc: boolean }[] = [];
	const oscAt = SRC.indexOf("editor.onOsc(");
	for (let i = SRC.indexOf("resolveGround("); i >= 0; i = SRC.indexOf("resolveGround(", i + 1)) {
		const call = SRC.slice(i, SRC.indexOf(")", i) + 1);
		out.push({ insideOscCallback: oscAt >= 0 && i > oscAt, passesOsc: /\bosc\b/.test(call) });
	}
	return out;
}

describe("DC-14 — the ground is resolved at startup, not only on an OSC reply", () => {
	it("at least one call sits OUTSIDE the OSC-reply callback", () => {
		const calls = groundCalls();
		expect(calls.length, "resolveGround is not called at all").toBeGreaterThan(0);
		expect(calls.some((c) => !c.insideOscCallback), "every resolveGround call is inside editor.onOsc — the environment rungs are dead on a terminal that does not answer OSC 11").toBe(true);
	});

	it("the startup call passes NO osc, so it cannot be waiting for one", () => {
		const startup = groundCalls().filter((c) => !c.insideOscCallback);
		for (const c of startup) expect(c.passesOsc).toBe(false);
	});

	// RE-DERIVED (2026-09-02): rung 1 is no longer a bare `process.env`
	// read at the call site — it is `theme()`, which is
	// `process.env.KISO_THEME ?? userTheme` so the persisted setting can
	// answer on a terminal that reports nothing. The PROPERTY is
	// unchanged and is what is asserted: the startup call feeds both env
	// rungs. Asserting the literal `KISO_THEME` inside the call would be
	// asserting the indirection has not happened, which is not the rule.
	it("the startup call feeds BOTH env rungs — theme and COLORFGBG", () => {
		const i = SRC.indexOf("setGround(resolveGround(");
		const call = SRC.slice(i, SRC.indexOf(")", SRC.indexOf("}", i)) + 1);
		expect(call, "rung 1 is not fed at startup").toMatch(/theme:/);
		expect(call, "COLORFGBG is not fed at startup").toContain("COLORFGBG");
		// and rung 1 really does resolve to the environment first
		const fn = SRC.slice(SRC.indexOf("const theme = ("), SRC.indexOf("\n", SRC.indexOf("const theme = (")));
		expect(fn).toContain("process.env.KISO_THEME");
	});

	it("its result is APPLIED — resolving without setGround would change nothing", () => {
		expect(SRC).toMatch(/setGround\(\s*resolveGround\(/);
	});

	// and the ladder itself still behaves, from the CLI's own import — the
	// half that always passed, kept so a regression here is attributable
	it("the human's answer beats COLORFGBG, with no osc in sight", () => {
		expect(resolveGround({ theme: "dark", colorfgbg: "0;15" })).toBe("dark");
		expect(resolveGround({ theme: "light", colorfgbg: "15;0" })).toBe("light");
	});

	it("COLORFGBG answers when the human set nothing — the case the defect made unreachable", () => {
		expect(resolveGround({ colorfgbg: "0;15" })).toBe("light");
		expect(resolveGround({ colorfgbg: "15;0" })).toBe("dark");
	});

	it("nothing at all is `unknown`, which is a supported palette", () => {
		expect(resolveGround({})).toBe("unknown");
	});
});

/**
 * The 997 leg (2026-09-02): the ladder gained a rung, and a rung that is
 * never asked for is DC-14's own defect again.
 *
 * `CSI ? 996 n` asks the terminal to report its colour scheme. The
 * report is a CSI, not an OSC, and it reaches the ground by its own
 * callback — so the wiring has three parts that can each be absent
 * independently: the question is written, the answer is listened for,
 * and the answer is fed to the ladder. This reads the shipped entry
 * point for all three, at the only place they exist.
 */
describe("the colour-scheme probe is asked, heard, and used", () => {
	it("the question is WRITTEN — and on the same gate as OSC 11, in one write", () => {
		const at = SRC.indexOf("\\x1b[?996n");
		expect(at, "the CSI 996 probe is never written").toBeGreaterThan(0);
		// the same statement carries both: one gate, not a second opinion
		const stmt = SRC.slice(SRC.lastIndexOf("if (", at), SRC.indexOf("\n", at));
		expect(stmt, "the probe rides the colour gate").toContain("palette().bold");
		expect(stmt, "the probe rides the TTY gate").toContain("process.stdout.isTTY");
		expect(stmt, "both questions in one write").toContain("\\x1b]11;?");
	});

	it("the answer is LISTENED for, on its own channel", () => {
		expect(SRC).toContain("editor.onColorScheme(");
		// and not folded into the OSC channel, which carries a different fact
		const osc = SRC.slice(SRC.indexOf("editor.onOsc("), SRC.indexOf("editor.onColorScheme("));
		expect(osc, "the colour scheme is not read out of an OSC body").not.toContain("colorScheme =");
	});

	it("the answer is USED — it reaches resolveGround", () => {
		const calls = [...SRC.matchAll(/resolveGround\(\{[^}]*\}/g)].map((m) => m[0]);
		expect(calls.some((c) => /\bcolorScheme\b/.test(c)), "no resolveGround call is given the colour scheme").toBe(true);
	});

	it("the USER's theme reaches the ladder too, and the environment outranks it", () => {
		expect(SRC).toContain("loadUserConfig()?.theme");
		expect(SRC, "KISO_THEME must win over the config file").toContain("process.env.KISO_THEME ?? userTheme");
	});
});
