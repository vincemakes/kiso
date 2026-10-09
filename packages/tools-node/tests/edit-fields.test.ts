/**
 * ADR-0061 — `edit_file` speaks `oldText`/`newText`.
 *
 * The replay of the 2026-10-08 witness round found 80 of 86 failed T6
 * edits with `search` and `replace` SWAPPED: the anchor in `replace`, the
 * anchor plus the new code in `search`. The two words can be read either
 * way round ("replace" as the text to replace); old/new cannot.
 *
 * The principle: compatibility belongs in the executor, vocabulary in the
 * schema. The model sees one form — `edits` of `{oldText, newText}` — and
 * the executor still takes every shape a durable log or a host may hold.
 *
 * What an implementation gets wrong here:
 *  - leaving a legacy name in the advertised schema (the model keeps
 *    learning the old vocabulary), or dropping it from the executor (an
 *    approved call persisted before the upgrade cannot run);
 *  - a mixed hunk (`oldText` with `replace`) silently taking one half;
 *  - the swap hint applying the swapped edit (a guess that writes), or
 *    firing on a miss that is not the swap shape.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArgs } from "@vincemakes/kiso-core";
import { describe, expect, it } from "vitest";
import { editFileTool } from "../src/index.js";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;

function ws(text: string): { edit: ReturnType<typeof editFileTool>; rev: string; read: () => string } {
	const root = mkdtempSync(join(tmpdir(), "kiso-ef-"));
	writeFileSync(join(root, "f.js"), text);
	return { edit: editFileTool({ workspaceRoot: root }), rev: rev(text), read: () => readFileSync(join(root, "f.js"), "utf8") };
}

const SRC = ["export function a() {", "\treturn 1;", "}", ""].join("\n");
const run = (w: ReturnType<typeof ws>, input: Record<string, unknown>) => w.edit.execute({ path: "f.js", expectedRevision: w.rev, ...input } as never, {} as never);

describe("the advertised schema — one vocabulary", () => {
	const tool = editFileTool({ workspaceRoot: tmpdir() });
	const p = tool.parameters as { properties: Record<string, { items?: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }>; required: string[] };

	it("is path + edits[{oldText, newText}] + expectedRevision, all required", () => {
		expect(Object.keys(p.properties).sort()).toEqual(["edits", "expectedRevision", "path"]);
		expect([...p.required].sort()).toEqual(["edits", "expectedRevision", "path"]);
		const items = p.properties.edits!.items!;
		expect(Object.keys(items.properties).sort()).toEqual(["newText", "oldText"]);
		expect([...items.required].sort()).toEqual(["newText", "oldText"]);
		expect(items.additionalProperties).toBe(false);
	});

	it("describes both fields, with the in-order contract on oldText (ACI-3 kept)", () => {
		const items = p.properties.edits!.items!.properties as Record<string, { description?: string }>;
		expect(items.oldText!.description).toMatch(/after the earlier edits in this call/);
		expect(items.newText!.description).toMatch(/oldText/);
	});

	it("keeps the description under WR-1E's 220 characters and asks for known changes in one call", () => {
		expect(tool.description.length).toBeLessThanOrEqual(220);
		expect(tool.description).toMatch(/already known/);
		expect(tool.description).not.toMatch(/search|replace\b/);
		expect(tool.promptSnippet).toMatch(/oldText/);
		expect(tool.promptSnippet).not.toMatch(/old_string/);
	});

	it("refuses the legacy vocabulary from the model: search/replace hunks, a top-level pair, a hunk-level expectedRevision", () => {
		const base = { path: "f.js", expectedRevision: "rev:0000000000000000" };
		expect(validateArgs(tool.parameters, { ...base, edits: [{ search: "a", replace: "b" }] })).not.toBeNull();
		expect(validateArgs(tool.parameters, { ...base, search: "a", replace: "b" })).not.toBeNull();
		expect(validateArgs(tool.parameters, { ...base, edits: [{ oldText: "a", newText: "b", expectedRevision: "rev:1" }] })).not.toBeNull();
		expect(validateArgs(tool.parameters, { ...base, edits: [{ oldText: "a", replace: "b" }] })).not.toBeNull();
		expect(validateArgs(tool.parameters, { ...base, edits: [{ oldText: "a", newText: "b" }] })).toBeNull();
	});
});

describe("the new vocabulary edits", () => {
	it("applies one replacement", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "\treturn 1;", newText: "\treturn 2;" }] });
		expect(r.isError).toBe(false);
		expect(w.read()).toBe(SRC.replace("return 1", "return 2"));
	});

	it("applies several in order, each against the result of the ones before (ACI-3)", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "return 1;", newText: "return 2;" }, { oldText: "return 2;", newText: "return 3;" }] });
		expect(r.isError).toBe(false);
		expect(w.read()).toBe(SRC.replace("return 1", "return 3"));
	});

	it("is all or nothing: a later miss writes nothing", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "return 1;", newText: "return 2;" }, { oldText: "nowhere", newText: "x" }] });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/^edit_file: pattern not found in f\.js \(hunk 2, after hunk 1 applied\)/);
		expect(w.read()).toBe(SRC);
	});

	it("keeps the refusal headlines byte-identical (bench parsers read them)", async () => {
		const w = ws("x\nx\n");
		const r = await run(w, { edits: [{ oldText: "x", newText: "y" }] });
		expect(r.content).toMatch(/^edit_file: pattern matches 2 places in f\.js \(hunk 1, /);
	});
});

describe("the executor keeps the legacy shapes (callers that skip schema validation)", () => {
	it("a legacy hunk edits", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ search: "return 1;", replace: "return 2;" }] });
		expect(r.isError).toBe(false);
		expect(w.read()).toBe(SRC.replace("return 1", "return 2"));
	});

	it("the legacy top-level pair edits", async () => {
		const w = ws(SRC);
		const r = await run(w, { search: "return 1;", replace: "return 2;" });
		expect(r.isError).toBe(false);
		expect(w.read()).toBe(SRC.replace("return 1", "return 2"));
	});

	it("a hunk-level expectedRevision is ignored, as before", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "return 1;", newText: "return 2;", expectedRevision: "rev:ffffffffffffffff" }] });
		expect(r.isError).toBe(false);
	});

	it("a hunk mixing the two vocabularies is refused, naming both sets, and writes nothing", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "return 1;", replace: "return 2;" }] });
		expect(r.isError).toBe(true);
		expect((r as { errorKind?: string }).errorKind).toBe("invalid_input");
		expect(r.content).toMatch(/hunk 1 mixes oldText\/newText with search\/replace/);
		expect(w.read()).toBe(SRC);
	});

	it("edits together with a top-level pair is refused", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "return 1;", newText: "return 2;" }], search: "a", replace: "b" });
		expect(r.isError).toBe(true);
		expect((r as { errorKind?: string }).errorKind).toBe("invalid_input");
		expect(w.read()).toBe(SRC);
	});

	it("no edits at all names the current form", async () => {
		const w = ws(SRC);
		const r = await run(w, {});
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/pass edits — 1–32 \{oldText, newText\} replacements/);
	});
});

describe("the swap hint — evidence, never a guess", () => {
	// The witness round's shape: the anchor in newText, the anchor plus the new code in oldText.
	const ANCHOR = "export function a() {\n\treturn 1;\n}";
	const WITH_NEW = `${ANCHOR}\n\nexport function b() {\n\treturn 2;\n}`;

	it("names both readings when oldText is absent and newText matches once — and writes nothing", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: WITH_NEW, newText: ANCHOR }] });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/^edit_file: pattern not found in f\.js/);
		expect(r.content).toMatch(/newText is already in the file once and oldText is not: either this change is already applied, or oldText and newText are swapped/);
		expect(w.read()).toBe(SRC);
	});

	it("does not fire when newText is absent too", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "nowhere", newText: "elsewhere" }] });
		expect(r.content).not.toMatch(/swapped/);
	});

	it("does not fire when newText matches more than once", async () => {
		const w = ws("k\nk\n");
		const r = await run(w, { edits: [{ oldText: "nowhere", newText: "k" }] });
		expect(r.content).not.toMatch(/swapped/);
	});

	it("speaks of the hunk it is about, after the earlier hunks applied", async () => {
		const w = ws(SRC);
		const r = await run(w, { edits: [{ oldText: "return 1;", newText: "return 9;" }, { oldText: "return 7;", newText: "return 9;" }] });
		expect(r.content).toMatch(/\(hunk 2, after hunk 1 applied\)/);
		expect(r.content).toMatch(/swapped/);
		expect(w.read()).toBe(SRC);
	});
});
