/**
 * Modes — the five built-in approval tiers, unit-tested: the verdict
 * matrix (tiers × representative tools), the chain shape (only the
 * CURRENT tier speaks; it sits FIRST so an all-allow chain records it
 * as decidedBy), the startup resolution (KISO_MODE / --mode), and the
 * plan tier's system-prompt add.
 */

import { describe, expect, it } from "vitest";
import { MODES, getMode, modeExtensions, modeFromEnv, modeSystemPrompt, setMode, type Mode } from "../src/mode.js";

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

describe("Modes: the five-tier verdict matrix", () => {
	it("manual asks for EVERY tool", async () => {
		for (const tool of [...READ, ...WRITE_EDIT, "shell", "some_tool"]) {
			expect(await verdict("manual", tool)).toEqual({ action: "ask" });
		}
	});

	it("default keeps the safe-defaults semantics: reads allowed, write/edit/shell asked, unknown tools UNTOUCHED", async () => {
		for (const tool of READ) expect(await verdict("default", tool)).toEqual({ action: "allow" });
		for (const tool of [...WRITE_EDIT, "shell"]) expect(await verdict("default", tool)).toEqual({ action: "ask" });
		// An extension-provided tool is the extensions' business — the tier
		// has no opinion (the chain then honors their allow/ask/deny).
		expect(await verdict("default", "some_tool")).toEqual({ action: "allow" });
	});

	it("accept-edits allows edits too — shell is still asked, unknowns untouched", async () => {
		for (const tool of READ) expect(await verdict("accept-edits", tool)).toEqual({ action: "allow" });
		for (const tool of WRITE_EDIT) expect(await verdict("accept-edits", tool)).toEqual({ action: "allow" });
		expect(await verdict("accept-edits", "shell")).toEqual({ action: "ask" });
		expect(await verdict("accept-edits", "some_tool")).toEqual({ action: "allow" });
	});

	it("plan is read-only: reads allowed, EVERYTHING else denied with the guiding reason", async () => {
		for (const tool of READ) expect(await verdict("plan", tool)).toEqual({ action: "allow" });
		for (const tool of [...WRITE_EDIT, "shell", "some_tool"]) {
			expect(await verdict("plan", tool)).toEqual({ action: "deny", reason: "plan mode: read-only" });
		}
	});

	it("bypass allows everything", async () => {
		for (const tool of [...READ, ...WRITE_EDIT, "shell", "some_tool"]) {
			expect(await verdict("bypass", tool)).toEqual({ action: "allow" });
		}
	});
});

describe("Modes: the chain shape", () => {
	it("only the CURRENT tier speaks — the others have no opinion (all-allow)", async () => {
		setMode("plan");
		for (const e of modeExtensions()) {
			const v = await e.approvals![0]!.decide({ name: "write_file" } as never, {} as never);
			if (e.name === "mode:plan") {
				expect(v).toEqual({ action: "deny", reason: "plan mode: read-only" });
			} else {
				expect(v).toEqual({ action: "allow" });
			}
		}
	});

	it("the CURRENT tier is FIRST in the chain — an all-allow chain records it as decidedBy", () => {
		setMode("bypass");
		expect(modeExtensions()[0]!.name).toBe("mode:bypass");
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
	it("modeFromEnv resolves KISO_MODE, defaulting to default", () => {
		const saved = process.env.KISO_MODE;
		try {
			process.env.KISO_MODE = "plan";
			expect(modeFromEnv()).toBe("plan");
			process.env.KISO_MODE = "bogus";
			expect(modeFromEnv()).toBe("default");
			delete process.env.KISO_MODE;
			expect(modeFromEnv()).toBe("default");
		} finally {
			if (saved === undefined) delete process.env.KISO_MODE;
			else process.env.KISO_MODE = saved;
		}
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
