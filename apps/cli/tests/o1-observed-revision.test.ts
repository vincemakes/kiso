import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { activeStoreDir, observedRevisionFromLog, setActiveStoreDir } from "../src/state.js";

/**
 * O1 — the hidden observed revision (kiso-doc design-o1, f64309e; the
 * O1.1 binder, report-shipgate-p11o1-interim-2026-10-11 §C).
 *
 * In Kiso Code, edit_file and write_file take no expectedRevision: the
 * host binds the revision the model last OBSERVED, rebuilt from the
 * session's model-visible history. These are the fourteen semantic probes
 * of the gate, ported from a real T6 log onto synthetic ones:
 *
 *   - the binding is the OBSERVED revision, never the disk's latest, so a
 *     stale write stays refused;
 *   - another session (a subagent child) inherits no observation;
 *   - an unobserved file is never edited or replaced; a new file is
 *     created;
 *   - a whole-file replace needs visible whole-file knowledge;
 *   - compaction removes what the model can no longer see.
 */

const rev = (p: string): string => `rev:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`;

let work: string;
let store: string;
let cwd: string;
let previousStore: string;
let seq: number;
const SID = "o1-session";

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "kiso-o1-"));
	store = join(work, "store");
	mkdirSync(store);
	mkdirSync(join(work, "repo", "src"), { recursive: true });
	writeFileSync(join(work, "repo", "src", "range.js"), "export const range = (n) => [...Array(n).keys()];\n");
	cwd = process.cwd();
	process.chdir(join(work, "repo"));
	previousStore = activeStoreDir;
	setActiveStoreDir(store);
	seq = 0;
	append(SID, { type: "user_input", content: "go" });
});

afterEach(() => {
	process.chdir(cwd);
	setActiveStoreDir(previousStore);
});

function append(sessionId: string, event: Record<string, unknown>): void {
	appendFileSync(join(store, `${sessionId}.jsonl`), `${JSON.stringify({ runId: "r", ts: 0, event: { seq: seq++, ...event } })}\n`);
}

const tools = () => Object.fromEntries(createCodingTools({ workspaceRoot: process.cwd(), observedRevision: observedRevisionFromLog }).map((t) => [t.name, t]));
const ctx = (sessionId = SID) => ({ signal: new AbortController().signal, sessionId });
const F = () => join(process.cwd(), "src", "range.js");

/** Run a tool for real and record the turn the way the kernel does. */
async function call(name: string, input: Record<string, unknown>, sessionId = SID): Promise<{ content: string; isError: boolean; tags?: readonly string[] }> {
	const r = (await tools()[name]!.execute(input as never, ctx(sessionId) as never)) as { content: string; isError: boolean; tags?: readonly string[] };
	const callId = `c${seq}`;
	append(sessionId, { type: "tool_call_start", callId, name });
	append(sessionId, { type: "tool_call_end", callId, name, input });
	append(sessionId, { type: "stop", reason: "tool_use" });
	append(sessionId, { type: "tool_result", callId, content: r.content, isError: r.isError });
	return r;
}

describe("O1: the binding is the observed revision", () => {
	it("no observation, no binding: an edit is refused and names the read", async () => {
		expect(observedRevisionFromLog(SID, F())).toBeUndefined();
		const r = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "range", newText: "span" }] });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/read it first/);
	});

	it("a read binds the file's revision, and the edit lands", async () => {
		await call("read_file", { path: "src/range.js" });
		expect(observedRevisionFromLog(SID, F())).toBe(rev(F()));
		const r = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "range", newText: "span" }] });
		expect(r.isError).toBe(false);
		expect(readFileSync(F(), "utf8")).toContain("span");
	});

	it("an own edit's receipt carries the chain: the next edit needs no re-read", async () => {
		await call("read_file", { path: "src/range.js" });
		await call("edit_file", { path: "src/range.js", edits: [{ oldText: "range", newText: "span" }] });
		expect(observedRevisionFromLog(SID, F())).toBe(rev(F()));
		const r = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "keys", newText: "values" }] });
		expect(r.isError).toBe(false);
	});

	it("an external change after the observation is refused as stale — never bound to the disk's latest", async () => {
		await call("read_file", { path: "src/range.js" });
		writeFileSync(F(), `${readFileSync(F(), "utf8")}// external\n`);
		const r = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "// external", newText: "// x" }] });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/changed since you last observed it/);
		// the refusal carries the current text and revision: it is an observation
		expect(observedRevisionFromLog(SID, F())).toBe(rev(F()));
		const retry = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "// external", newText: "// x" }] });
		expect(retry.isError).toBe(false);
	});

	it("another session (a subagent child) inherits no observation", async () => {
		await call("read_file", { path: "src/range.js" });
		expect(observedRevisionFromLog("child-session", F())).toBeUndefined();
		const r = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "range", newText: "span" }] }, "child-session");
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/read it first/);
	});
});

describe("O1: write_file", () => {
	it("an unobserved existing file is not replaced", async () => {
		writeFileSync(join(process.cwd(), "src", "unseen.js"), "export const x = 1;\n");
		const r = await call("write_file", { path: "src/unseen.js", content: "zz" });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/read it before replacing it/);
		expect(readFileSync(join(process.cwd(), "src", "unseen.js"), "utf8")).toBe("export const x = 1;\n");
	});

	it("a new file is created, and the result is tagged for the host's card (never the model's text)", async () => {
		const r = await call("write_file", { path: "src/brand-new.js", content: "export {};\n" });
		expect(r.isError).toBe(false);
		expect(r.tags).toEqual(["created"]);
		expect(r.content).toMatch(/^wrote src\/brand-new\.js/);
	});

	it("a replace after a whole read binds; after a RANGED read it does not (edit still does)", async () => {
		await call("read_file", { path: "src/range.js", offset: 1, limit: 1 });
		expect(observedRevisionFromLog(SID, F(), "edit")).toBe(rev(F()));
		expect(observedRevisionFromLog(SID, F(), "write")).toBeUndefined();
		await call("read_file", { path: "src/range.js" });
		expect(observedRevisionFromLog(SID, F(), "write")).toBe(rev(F()));
		const r = await call("write_file", { path: "src/range.js", content: "export {};\n" });
		expect(r.isError).toBe(false);
		expect(r.tags).toBeUndefined();
	});
});

describe("O1: compaction removes what the model can no longer see", () => {
	it("after microcompaction a replace is refused until a fresh read", async () => {
		await call("read_file", { path: "src/range.js" });
		append(SID, { type: "microcompacted", beforeSeq: seq - 1 });
		expect(observedRevisionFromLog(SID, F(), "write")).toBeUndefined();
		const r = await call("write_file", { path: "src/range.js", content: "export {};\n" });
		expect(r.isError).toBe(true);
		await call("read_file", { path: "src/range.js" });
		expect(observedRevisionFromLog(SID, F(), "write")).toBe(rev(F()));
	});

	it("after a summary covering the history an edit is refused until a fresh read", async () => {
		await call("read_file", { path: "src/range.js" });
		append(SID, { type: "summarized", coversToSeq: seq - 1, summary: "earlier work" });
		expect(observedRevisionFromLog(SID, F())).toBeUndefined();
		const r = await call("edit_file", { path: "src/range.js", edits: [{ oldText: "range", newText: "span" }] });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/read it first/);
		await call("read_file", { path: "src/range.js" });
		expect(observedRevisionFromLog(SID, F())).toBe(rev(F()));
	});
});

describe("O1: the layering — the model-facing schema", () => {
	const spec = (bound: boolean, name: string) => {
		const t = createCodingTools({ workspaceRoot: "/tmp", ...(bound ? { observedRevision: () => undefined } : {}) }).find((x) => x.name === name)!;
		return t as unknown as { parameters: { properties: Record<string, unknown>; required: string[] }; promptGuidelines?: readonly string[] };
	};
	for (const name of ["edit_file", "write_file"]) {
		it(`${name}: bound, no expectedRevision and no revision guideline; unbound, the explicit protocol as before`, () => {
			expect(Object.keys(spec(true, name).parameters.properties)).not.toContain("expectedRevision");
			expect(spec(true, name).parameters.required).not.toContain("expectedRevision");
			expect(spec(true, name).promptGuidelines).toBeUndefined();
			expect(Object.keys(spec(false, name).parameters.properties)).toContain("expectedRevision");
			expect(spec(false, name).parameters.required).toContain("expectedRevision");
		});
	}
});
