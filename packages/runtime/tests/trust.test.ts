/**
 * E3 — the trust mechanism: projectArtifacts discovery + bundle digest,
 * the trust.jsonl store (last-wins, corrupt-line tolerance), and
 * loadProjectExtensions (name conflicts across levels are loud).
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectExtensions, projectArtifacts, recordTrust, trustFor } from "../src/index.js";

const homes: string[] = [];
function isolatedHome(): string {
	const home = mkdtempSync(join(tmpdir(), "kiso-trust-"));
	homes.push(home);
	return home;
}
afterEach(() => {
	for (const h of homes.splice(0)) {
		try {
			rmSync(h, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
	delete process.env.KISO_HOME;
});

function makeProject(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "kiso-proj-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = join(cwd, ".kiso", rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, content, "utf8");
	}
	return cwd;
}

describe("E3: projectArtifacts", () => {
	it("no .kiso dir → null", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "kiso-proj-"));
		expect(await projectArtifacts(cwd)).toBeNull();
	});

	it("an empty .kiso dir → null (nothing to gate)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "kiso-proj-"));
		mkdirSync(join(cwd, ".kiso"), { recursive: true });
		expect(await projectArtifacts(cwd)).toBeNull();
	});

	it("discovers all three artifact kinds with per-file digests and a bundle digest", async () => {
		const cwd = makeProject({
			"extensions/lint-rules.mjs": "export default { name: \"lint-rules\", tools: [] };\n",
			"mcp.json": "{\"mcpServers\": {}}\n",
			"skills/review/SKILL.md": "---\nname: review\ndescription: review the diff\n---\nbody\n",
		});
		const artifacts = await projectArtifacts(cwd);
		expect(artifacts).not.toBeNull();
		const paths = artifacts!.files.map((f) => f.path).sort();
		expect(paths).toEqual(["extensions/lint-rules.mjs", "mcp.json", "skills/review/SKILL.md"]);
		expect(artifacts!.files.every((f) => /^[0-9a-f]{64}$/.test(f.digest))).toBe(true);
		expect(/^[0-9a-f]{64}$/.test(artifacts!.digest)).toBe(true);
		expect(artifacts!.files.find((f) => f.kind === "extension")?.path).toBe("extensions/lint-rules.mjs");
		expect(artifacts!.files.find((f) => f.kind === "mcp")?.path).toBe("mcp.json");
		expect(artifacts!.files.find((f) => f.kind === "skill")?.path).toBe("skills/review/SKILL.md");
	});

	it("any file change changes the bundle digest — the trust decision dies", async () => {
		const cwd = makeProject({ "extensions/a.mjs": "export default { name: \"a\", tools: [] };\n" });
		const before = await projectArtifacts(cwd);
		expect(before).not.toBeNull();
		writeFileSync(join(cwd, ".kiso", "extensions", "a.mjs"), "export default { name: \"a\", tools: [\"x\"] };\n", "utf8");
		const after = await projectArtifacts(cwd);
		expect(after!.digest).not.toBe(before!.digest);
		expect(after!.files[0]!.digest).not.toBe(before!.files[0]!.digest);
	});

	it("adding or removing a file changes the bundle digest", async () => {
		const cwd = makeProject({ "extensions/a.mjs": "x\n" });
		const before = await projectArtifacts(cwd);
		expect(before).not.toBeNull();
		writeFileSync(join(cwd, ".kiso", "extensions", "b.mjs"), "y\n", "utf8");
		const after = await projectArtifacts(cwd);
		expect(after!.digest).not.toBe(before!.digest);
	});

	it("digest is order-independent — the same set in any discovery order hashes the same", async () => {
		const cwd = makeProject({
			"extensions/a.mjs": "a\n",
			"extensions/b.mjs": "b\n",
			"mcp.json": "m\n",
			"skills/s1/SKILL.md": "s\n",
		});
		const a = await projectArtifacts(cwd);
		expect(a).not.toBeNull();
		const b = await projectArtifacts(cwd);
		expect(b!.digest).toBe(a!.digest);
	});

	it("a non-*.mjs file in extensions/ and a nested skill are inert — not in the manifest", async () => {
		const cwd = makeProject({
			"extensions/README.txt": "notes\n",
			"extensions/real.mjs": "export default { name: \"real\", tools: [] };\n",
			"skills/nested/deep/SKILL.md": "---\nname: deep\ndescription: x\n---\n",
		});
		const artifacts = await projectArtifacts(cwd);
		expect(artifacts!.files.map((f) => f.path)).toEqual(["extensions/real.mjs"]);
	});

	it("the root is the realpath of the .kiso dir", async () => {
		const cwd = makeProject({ "extensions/a.mjs": "x\n" });
		const artifacts = await projectArtifacts(cwd);
		// macOS /tmp → /private/tmp: realpath canonicalizes, the raw join does not.
		expect(artifacts!.root).toBe(realpathSync(join(cwd, ".kiso")));
	});
});

describe("E3: the trust store", () => {
	it("no trust file → null", () => {
		process.env.KISO_HOME = isolatedHome();
		expect(trustFor("/x", "deadbeef")).toBeNull();
	});

	it("recordTrust then trustFor round-trips, respecting KISO_HOME", () => {
		process.env.KISO_HOME = isolatedHome();
		recordTrust({ root: "/proj/.kiso", digest: "abc", decision: "granted" });
		const rec = trustFor("/proj/.kiso", "abc");
		expect(rec?.decision).toBe("granted");
		expect(rec?.root).toBe("/proj/.kiso");
		expect(rec?.digest).toBe("abc");
		expect(typeof rec?.ts).toBe("string");
		expect(readFileSync(join(process.env.KISO_HOME, "trust.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("the LAST record matching (root, digest) wins", () => {
		process.env.KISO_HOME = isolatedHome();
		recordTrust({ root: "/p", digest: "d1", decision: "granted" });
		recordTrust({ root: "/p", digest: "d1", decision: "refused" });
		expect(trustFor("/p", "d1")?.decision).toBe("refused");
	});

	it("a different digest has no record — the trust decision dies with the files", () => {
		process.env.KISO_HOME = isolatedHome();
		recordTrust({ root: "/p", digest: "d1", decision: "granted" });
		expect(trustFor("/p", "d2")).toBeNull();
	});

	it("corrupt lines are skipped — trust is a memo, not an event stream", () => {
		process.env.KISO_HOME = isolatedHome();
		writeFileSync(
			join(process.env.KISO_HOME, "trust.jsonl"),
			`{"root":"/p","digest":"d1","decision":"granted","ts":"t"}\nnot json at all\n{"root": 42}\n{"root":"/p","digest":"d1","decision":"refused","ts":"t2"}\n`,
			"utf8",
		);
		const rec = trustFor("/p", "d1");
		expect(rec?.decision).toBe("refused"); // the corrupt lines in between never throw and never match
	});

	it("a refused decision is sticky — trustFor returns it like any record", () => {
		process.env.KISO_HOME = isolatedHome();
		recordTrust({ root: "/p", digest: "d1", decision: "refused" });
		expect(trustFor("/p", "d1")?.decision).toBe("refused");
	});
});

describe("E3: loadProjectExtensions", () => {
	it("no project extensions dir → []", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "kiso-proj-"));
		expect(await loadProjectExtensions(cwd)).toEqual([]);
	});

	it("loads <dir>/.kiso/extensions/*.mjs", async () => {
		const cwd = makeProject({ "extensions/lint-rules.mjs": "export default { name: \"lint-rules\", tools: [] };\n" });
		const exts = await loadProjectExtensions(cwd);
		expect(exts.map((e) => e.name)).toEqual(["lint-rules"]);
	});

	it("a name in both levels is a LOUD error — never a silent shadow", async () => {
		const cwd = makeProject({ "extensions/dupe.mjs": "export default { name: \"dupe\", tools: [] };\n" });
		await expect(loadProjectExtensions(cwd, [{ name: "dupe", tools: [] }])).rejects.toThrow(/both the user-level and the project-level/);
	});

	it("a broken project extension fails loudly with the file name", async () => {
		const cwd = makeProject({ "extensions/broken.mjs": "export default 42;\n" });
		await expect(loadProjectExtensions(cwd)).rejects.toThrow(/broken\.mjs must default-export a KisoExtension/);
	});
});
