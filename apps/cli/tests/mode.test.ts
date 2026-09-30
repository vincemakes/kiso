/**
 * Modes — the built-in approval tiers and the don't-ask switch,
 * unit-tested: the verdict matrix (tiers × representative tools), the
 * chain shape (only the CURRENT tier speaks; it sits FIRST so an
 * all-allow chain records it as decidedBy), the startup resolution
 * (flag > env > project > user, old names included), and the plan tier's
 * system-prompt add.
 */

import { describe, expect, it } from "vitest";
import {
	DONT_ASK_NOTE,
	MODES,
	MODE_LABEL,
	MODE_NOTE,
	MODE_VALUES,
	OFFERED_MODES,
	applyModeSetting,
	applyModeState,
	envModeLayer,
	getDontAsk,
	getMode,
	modeDisplay,
	modeExtensions,
	modeSystemPrompt,
	parseMode,
	resolveModeLayers,
	setDontAsk,
	setMode,
	type Mode,
	type ModeLayer,
} from "../src/mode.js";

/** The current tier's policy — the first extension of the chain. */
function currentPolicy(tier: Mode) {
	setMode(tier);
	const ext = modeExtensions().find((e) => e.name === `mode:${tier}`);
	if (ext === undefined || ext.approvals === undefined || ext.approvals[0] === undefined) {
		throw new Error(`no mode:${tier} policy`);
	}
	return ext.approvals[0];
}

function verdict(tier: Mode, tool: string) {
	return currentPolicy(tier).decide({ name: tool } as never, {} as never);
}

const READ = ["read_file", "list_dir", "search_text", "read_skill"];
const WRITE_EDIT = ["write_file", "edit_file"];

describe("Modes: the verdict matrix", () => {
	it("manual asks for EVERY tool", async () => {
		for (const tool of [...READ, ...WRITE_EDIT, "shell", "some_tool"]) {
			expect(await verdict("manual", tool)).toEqual({ action: "ask" });
		}
	});

	it("default keeps the safe-defaults semantics: reads allowed, write/edit/shell asked, unknown tools ABSTAINED", async () => {
		for (const tool of READ) expect(await verdict("default", tool)).toEqual({ action: "allow" });
		for (const tool of [...WRITE_EDIT, "shell"]) expect(await verdict("default", tool)).toEqual({ action: "ask" });
		// An extension-provided tool is the extensions' business — the tier
		// has no opinion. Abstain (ADR-0042), NEVER allow-as-no-opinion:
		// the chain falls to the ask flow when nobody else speaks, so an
		// uncovered external tool still meets the human.
		expect(await verdict("default", "some_tool")).toEqual({ action: "abstain" });
	});

	it("accept-edits allows edits too — shell is still asked, unknowns abstained", async () => {
		for (const tool of READ) expect(await verdict("accept-edits", tool)).toEqual({ action: "allow" });
		for (const tool of WRITE_EDIT) expect(await verdict("accept-edits", tool)).toEqual({ action: "allow" });
		expect(await verdict("accept-edits", "shell")).toEqual({ action: "ask" });
		expect(await verdict("accept-edits", "some_tool")).toEqual({ action: "abstain" });
	});

	it("the don't-ask switch changes NO tier's decision — the difference is at the ask endpoint, not in the chain", async () => {
		try {
			for (const tier of MODES) {
				for (const tool of [...READ, ...WRITE_EDIT, "shell", "some_tool"]) {
					setDontAsk(false);
					const asking = await verdict(tier, tool);
					setDontAsk(true);
					expect(await verdict(tier, tool), `${tier} ${tool}`).toEqual(asking);
				}
			}
		} finally {
			setDontAsk(false);
		}
	});

	it("four tiers are offered; manual stays ACCEPTED, and the old names are values, never tiers", () => {
		expect(OFFERED_MODES).toEqual(["default", "accept-edits", "plan", "full-access"]);
		expect(MODES).toContain("manual");
		expect(OFFERED_MODES).not.toContain("manual");
		for (const m of OFFERED_MODES) expect(MODES).toContain(m);
		expect(MODES as readonly string[]).not.toContain("bypass");
		expect(MODES as readonly string[]).not.toContain("dontAsk");
		for (const v of ["manual", "default", "accept-edits", "plan", "full-access", "bypass", "dontAsk"]) expect(MODE_VALUES).toContain(v);
	});

	it("every offered note, and the switch's, fits the picker at 80 columns: 80 − 19 (the label column) − 1 (never written) = 60", () => {
		// measured on the real PTY: a 61-character note lost its last letter
		for (const m of OFFERED_MODES) expect(MODE_NOTE[m].length, m).toBeLessThanOrEqual(60);
		expect(DONT_ASK_NOTE.length).toBeLessThanOrEqual(60);
	});

	it("a person reads labels, a config holds values: full access / accept edits", () => {
		expect(MODE_LABEL["full-access"]).toBe("full access");
		expect(MODE_LABEL["accept-edits"]).toBe("accept edits");
		expect(MODE_LABEL.default).toBe("default");
		expect(MODE_LABEL.plan).toBe("plan");
	});

	it("plan is read-only: reads allowed, EVERYTHING else denied with the guiding reason", async () => {
		for (const tool of READ) expect(await verdict("plan", tool)).toEqual({ action: "allow" });
		for (const tool of [...WRITE_EDIT, "shell", "some_tool"]) {
			expect(await verdict("plan", tool)).toEqual({ action: "deny", reason: "plan mode: read-only" });
		}
	});

	it("full-access allows everything", async () => {
		for (const tool of [...READ, ...WRITE_EDIT, "shell", "some_tool"]) {
			expect(await verdict("full-access", tool)).toEqual({ action: "allow" });
		}
	});
});

describe("Modes: the chain shape", () => {
	it("only the CURRENT tier speaks — the others ABSTAIN (no opinion, never a silent allow)", async () => {
		setMode("plan");
		for (const e of modeExtensions()) {
			const v = await e.approvals![0]!.decide({ name: "write_file" } as never, {} as never);
			if (e.name === "mode:plan") {
				expect(v).toEqual({ action: "deny", reason: "plan mode: read-only" });
			} else {
				expect(v).toEqual({ action: "abstain" });
			}
		}
		// full-access is a REAL allow — never an abstain (the neutral tier for
		// headless children; abstaining would stall them on asks).
		setMode("full-access");
		const full = modeExtensions().find((e) => e.name === "mode:full-access");
		expect(await full!.approvals![0]!.decide({ name: "some_tool" } as never, {} as never)).toEqual({ action: "allow" });
	});

	it("the CURRENT tier is FIRST in the chain — an all-allow chain records it as decidedBy", () => {
		setMode("full-access");
		expect(modeExtensions()[0]!.name).toBe("mode:full-access");
		setMode("accept-edits");
		expect(modeExtensions()[0]!.name).toBe("mode:accept-edits");
		setMode("default");
		expect(modeExtensions()[0]!.name).toBe("mode:default");
	});

	it("switching is live — a switch changes the verdict of the SAME chain", async () => {
		setMode("plan");
		const plan = await verdict("plan", "write_file");
		setMode("default");
		const def = await verdict("default", "write_file");
		expect(plan).toEqual({ action: "deny", reason: "plan mode: read-only" });
		expect(def).toEqual({ action: "ask" });
	});
});

describe("Modes: startup and prompt", () => {
	it("envModeLayer reads KISO_MODE as written and KISO_DONT_ASK as on/off; an unreadable switch is no value", () => {
		expect(envModeLayer({ KISO_MODE: "plan" })).toEqual({ mode: "plan" });
		expect(envModeLayer({})).toEqual({});
		for (const on of ["1", "true", "on", "TRUE", " 1 "]) expect(envModeLayer({ KISO_DONT_ASK: on }), on).toEqual({ dontAsk: true });
		for (const off of ["0", "false", "off"]) expect(envModeLayer({ KISO_DONT_ASK: off }), off).toEqual({ dontAsk: false });
		for (const junk of ["", "yes please", "2"]) expect(envModeLayer({ KISO_DONT_ASK: junk }), junk).toEqual({});
	});

	it("the plan tier carries the read-only directive in its prompt add", () => {
		setMode("default");
		expect(modeSystemPrompt()).toBeUndefined();
		setMode("plan");
		expect(modeSystemPrompt()).toContain("plan mode: read-only");
		expect(modeSystemPrompt()).toContain("read_file");
		setMode("manual");
		expect(modeSystemPrompt()).toBeUndefined();
	});

	it("setMode/getMode round-trip every tier", () => {
		for (const m of MODES) {
			setMode(m);
			expect(getMode()).toBe(m);
		}
	});
});

describe("Modes: the old names keep their meaning", () => {
	it("parseMode reads every value, every label, and the two old names", () => {
		for (const m of MODES) expect(parseMode(m), m).toEqual({ mode: m });
		expect(parseMode("full access")).toEqual({ mode: "full-access" });
		expect(parseMode("accept edits")).toEqual({ mode: "accept-edits" });
		expect(parseMode(" plan ")).toEqual({ mode: "plan" });
		// bypass is full-access's old name — nothing more
		expect(parseMode("bypass")).toEqual({ mode: "full-access" });
		// dontAsk was default's decisions with the switch on — NEVER
		// full-access with the switch on: read that way, an old config would
		// gain authority nobody gave it
		expect(parseMode("dontAsk")).toEqual({ mode: "default", dontAsk: true });
		for (const junk of ["bogus", "", "toString", "fullaccess", "Default"]) expect(parseMode(junk), junk).toBeUndefined();
	});
});

/** What the four layers resolved to while dontAsk was a tier: the first
 *  readable value, top down, and "asks?" is whether that value was
 *  dontAsk. Transcribed from the released resolution (0.45.2: --mode >
 *  KISO_MODE > project config > user config > default). */
const OLD_TIERS = ["manual", "default", "accept-edits", "plan", "bypass", "dontAsk"];
function asReleased(values: readonly (string | undefined)[]): { mode: Mode; dontAsk: boolean } {
	const won = values.find((v) => v !== undefined && OLD_TIERS.includes(v)) ?? "default";
	if (won === "dontAsk") return { mode: "default", dontAsk: true };
	return { mode: won === "bypass" ? "full-access" : (won as Mode), dontAsk: false };
}

describe("Modes: the resolution — flag > env > project > user > default, for each answer on its own", () => {
	it("EVERY combination of the released spellings, across the four layers, resolves exactly as it did when dontAsk was a tier", () => {
		// no unreadable values here: --mode rejects one (exit 2), a config
		// file rejects one loudly, and KISO_MODE's has its own case below
		const choices = [undefined, "manual", "default", "accept-edits", "plan", "bypass", "dontAsk"];
		let n = 0;
		for (const flag of choices)
			for (const env of choices)
				for (const project of choices)
					for (const user of choices) {
						const at = (v: string | undefined): ModeLayer | undefined => (v === undefined ? undefined : { mode: v });
						const got = resolveModeLayers({ flag: at(flag), env: at(env), project: at(project), user: at(user) });
						const want = asReleased([flag, env, project, user]);
						expect({ mode: got.mode, dontAsk: got.dontAsk !== "off" }, JSON.stringify({ flag, env, project, user })).toEqual(want);
						n++;
					}
		expect(n).toBe(7 ** 4);
	});

	it("an unreadable KISO_MODE is no value: the next layer decides, the project config included", () => {
		// a deliberate difference: 0.45.2 skipped the project config's mode
		// whenever KISO_MODE was SET, readable or not — so KISO_MODE=bogus
		// silently hid a trusted project's mode behind the user config's
		expect(resolveModeLayers({ env: { mode: "bogus" }, project: { mode: "plan" }, user: { mode: "full-access" } })).toMatchObject({ mode: "plan", from: { mode: "project" } });
	});

	it("the case the whole rule exists for: a user config saying dontAsk under --mode bypass still ASKS — the old name lost the tier, so it brings no switch", () => {
		const s = resolveModeLayers({ flag: { mode: "bypass" }, user: { mode: "dontAsk" } });
		expect(s).toEqual({ mode: "full-access", dontAsk: "off", from: { mode: "flag", dontAsk: "default" } });
	});

	it("the switch composes with any tier, from any layer", () => {
		expect(resolveModeLayers({ flag: { mode: "full-access", dontAsk: true } })).toMatchObject({ mode: "full-access", dontAsk: "on" });
		expect(resolveModeLayers({ flag: { mode: "full-access" }, user: { dontAsk: true } })).toMatchObject({ mode: "full-access", dontAsk: "on", from: { mode: "flag", dontAsk: "user" } });
		expect(resolveModeLayers({ env: { dontAsk: true }, project: { mode: "plan" } })).toMatchObject({ mode: "plan", dontAsk: "on", from: { mode: "project", dontAsk: "env" } });
		expect(resolveModeLayers({})).toEqual({ mode: "default", dontAsk: "off", from: { mode: "default", dontAsk: "default" } });
	});

	it("a higher layer decides the switch, whichever way it says it", () => {
		// --mode dontAsk on the command line outranks a user config's "dontAsk": false
		expect(resolveModeLayers({ flag: { mode: "dontAsk" }, user: { dontAsk: false } })).toMatchObject({ mode: "default", dontAsk: "old-name", from: { dontAsk: "flag" } });
		// KISO_DONT_ASK=0 outranks a project config's old-name dontAsk
		expect(resolveModeLayers({ env: { dontAsk: false }, project: { mode: "dontAsk" } })).toMatchObject({ mode: "default", dontAsk: "off", from: { dontAsk: "env" } });
		// in ONE layer the explicit key is the more specific word
		expect(resolveModeLayers({ user: { mode: "dontAsk", dontAsk: false } })).toMatchObject({ mode: "default", dontAsk: "off" });
		expect(resolveModeLayers({ user: { mode: "full-access", dontAsk: true } })).toMatchObject({ mode: "full-access", dontAsk: "on" });
	});
});

describe("Modes: the switch across tier changes", () => {
	const reset = (): void => applyModeState({ mode: "default", dontAsk: "off", from: { mode: "default", dontAsk: "default" } });

	it("a switch set on its own outlives every tier change", () => {
		try {
			setMode("default");
			setDontAsk(true);
			for (const m of OFFERED_MODES) {
				setMode(m);
				expect(getDontAsk(), m).toBe(true);
			}
			setDontAsk(false);
			expect(getDontAsk()).toBe(false);
			expect(getMode()).toBe("full-access");
		} finally {
			reset();
		}
	});

	it("a switch that came with the old dontAsk tier leaves with it — as leaving dontAsk always gave the asks back", () => {
		try {
			applyModeState(resolveModeLayers({ flag: { mode: "dontAsk" } }));
			expect(getMode()).toBe("default");
			expect(getDontAsk()).toBe(true);
			setMode("default"); // `/mode default` left dontAsk, and asked again
			expect(getDontAsk()).toBe(false);
			applyModeSetting(parseMode("dontAsk")!); // `/mode dontAsk` in a session
			expect(getDontAsk()).toBe(true);
			setMode("accept-edits");
			expect(getDontAsk()).toBe(false);
		} finally {
			reset();
		}
	});

	it("an old name never turns a switch set on its own into one that leaves", () => {
		try {
			setDontAsk(true);
			applyModeSetting(parseMode("dontAsk")!);
			setMode("plan");
			expect(getDontAsk()).toBe(true);
		} finally {
			reset();
		}
	});

	it("the status row names the tier by its label, the switch beside it only when on", () => {
		try {
			setMode("full-access");
			expect(modeDisplay()).toBe("full access");
			setDontAsk(true);
			expect(modeDisplay()).toBe("full access · don't ask");
			setMode("plan");
			expect(modeDisplay()).toBe("plan (read-only) · don't ask");
			setDontAsk(false);
			setMode("accept-edits");
			expect(modeDisplay()).toBe("accept edits");
		} finally {
			reset();
		}
	});
});
