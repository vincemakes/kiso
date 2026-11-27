/**
 * #31 (W1): a write outside the workspace and the Work's added folders asks in every asking tier. accept-edits' allow does not
 * cover it, nor does a saved allow; plan denies it, as every write; full-access runs it (the file tools' secret deny and stops
 * still refuse there). A relative path never leaves the workspace, and an added folder follows the tier as the workspace does.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { modeExtensions, setMode, type Mode } from "../src/mode.js";
import { guardSavedAllow, isOutsideWrite, neverInheritedCall } from "../src/protected-writes.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-31-w-")));
const root = join(base, "proj");
const added = join(base, "lib");
const away = join(base, "elsewhere");
for (const d of [root, added, away]) mkdirSync(d, { recursive: true });
const write = (path: string, name = "write_file") => ({ name, input: { path, content: "x" } });

afterEach(() => setMode("default"));

describe("isOutsideWrite", () => {
	it("an absolute path outside the workspace and the added folders; edit_file too", () => {
		expect(isOutsideWrite(write(join(away, "a.txt")), root, [added])).toBe(true);
		expect(isOutsideWrite(write(join(away, "a.txt"), "edit_file"), root, [added])).toBe(true);
	});

	it("not: inside the workspace (relative or absolute), inside an added folder, or a tool that does not write", () => {
		expect(isOutsideWrite(write("src/a.ts"), root, [added])).toBe(false);
		expect(isOutsideWrite(write(join(root, "src", "a.ts")), root, [added])).toBe(false);
		expect(isOutsideWrite(write(join(added, "b.ts")), root, [added])).toBe(false);
		expect(isOutsideWrite({ name: "read_file", input: { path: join(away, "a.txt") } }, root, [added])).toBe(false);
	});
});

describe("the tiers", () => {
	const decide = async (tier: Mode, path: string) => {
		setMode(tier);
		const ext = modeExtensions(() => root, () => tier, () => [added]).find((e) => e.name === `mode:${tier}`)!;
		return ext.approvals![0]!.decide(write(path), {} as never);
	};

	it("accept-edits asks for an outside write, allows the workspace and an added folder", async () => {
		expect(await decide("accept-edits", join(away, "a.txt"))).toEqual({ action: "ask" });
		expect(await decide("accept-edits", "src/a.ts")).toEqual({ action: "allow" });
		expect(await decide("accept-edits", join(added, "b.ts"))).toEqual({ action: "allow" });
	});

	it("default asks (as for every write); plan denies; full-access runs", async () => {
		expect(await decide("default", join(away, "a.txt"))).toEqual({ action: "ask" });
		expect((await decide("plan", join(away, "a.txt"))).action).toBe("deny");
		expect(await decide("full-access", join(away, "a.txt"))).toEqual({ action: "allow" });
	});
});

describe("a saved allow never carries one", () => {
	it("the guarded saved allow abstains for an outside write and still allows a workspace write", async () => {
		const rules = new Set(["write_file"]);
		const saved = { name: "dont-ask-again", rules, approvals: [{ decide: (call: { name: string }) => (rules.has(call.name) ? { action: "allow" as const } : { action: "abstain" as const }) }] } as unknown as KisoExtension;
		const guarded = guardSavedAllow(saved, (call) => neverInheritedCall(call, root, [added]));
		expect(await guarded.approvals![0]!.decide(write(join(away, "a.txt")), {} as never)).toEqual({ action: "abstain" });
		expect(await guarded.approvals![0]!.decide(write("src/a.ts"), {} as never)).toEqual({ action: "allow" });
		expect(await guarded.approvals![0]!.decide(write(join(added, "b.ts")), {} as never)).toEqual({ action: "allow" });
	});
});
