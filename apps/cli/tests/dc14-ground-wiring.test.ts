/**
 * DC-14 — the ground ladder is WALKED, not merely correct.
 *
 * `resolveGround` had a complete unit suite covering all four rungs and
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
		expect(calls.some((c) => !c.insideOscCallback), "every resolveGround call is inside editor.onOsc — rungs 1 and 3 are dead on a terminal that does not answer OSC 11").toBe(true);
	});

	it("the startup call passes NO osc, so it cannot be waiting for one", () => {
		const startup = groundCalls().filter((c) => !c.insideOscCallback);
		for (const c of startup) expect(c.passesOsc).toBe(false);
	});

	it("the startup call feeds BOTH env rungs — theme and COLORFGBG", () => {
		const i = SRC.indexOf("resolveGround(");
		const call = SRC.slice(i, SRC.indexOf(")", i) + 1);
		expect(call).toContain("KISO_THEME");
		expect(call).toContain("COLORFGBG");
	});

	it("its result is APPLIED — resolving without setGround would change nothing", () => {
		expect(SRC).toMatch(/setGround\(\s*resolveGround\(/);
	});

	// and the ladder itself still behaves, from the CLI's own import — the
	// half that always passed, kept so a regression here is attributable
	it("rung 1 beats rung 3, with no osc in sight", () => {
		expect(resolveGround({ theme: "dark", colorfgbg: "0;15" })).toBe("dark");
		expect(resolveGround({ theme: "light", colorfgbg: "15;0" })).toBe("light");
	});

	it("rung 3 answers when rung 1 is absent — the case the defect made unreachable", () => {
		expect(resolveGround({ colorfgbg: "0;15" })).toBe("light");
		expect(resolveGround({ colorfgbg: "15;0" })).toBe("dark");
	});

	it("nothing at all is `unknown`, which is a supported palette", () => {
		expect(resolveGround({})).toBe("unknown");
	});
});
