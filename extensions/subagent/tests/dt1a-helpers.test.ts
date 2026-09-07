/**
 * DT-1a — the contract's pure helpers, exported for gating: scope globs,
 * path normalization inside a root, the UNRESOLVED section parser, the
 * machine-format diff parser (numstat + name-status; renames and
 * binaries explicit, never a parsed --stat).
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globToRegExp, parseChangedFiles, parseUnresolved, pathInScope } from "../dist/kiso-subagent.mjs";

describe("DT-1a helpers", () => {
	it("globToRegExp: ** crosses directories, * stays inside one, ? is one char", () => {
		expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
		expect(globToRegExp("src/**").test("lib/a.ts")).toBe(false);
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
		expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
		expect(globToRegExp("a.b").test("axb")).toBe(false); // the dot is literal
	});

	it("pathInScope: relative to the root, `..` and symlinks resolved, outside is outside", () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-dt1a-scope-"));
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "lib"), { recursive: true });
		const elsewhere = mkdtempSync(join(tmpdir(), "kiso-dt1a-else-"));
		symlinkSync(elsewhere, join(root, "src", "link"));
		const scope = ["src/**"];
		expect(pathInScope(root, "src/a.ts", scope)).toBe(true);
		expect(pathInScope(root, join(root, "src", "deep", "b.ts"), scope)).toBe(true);
		expect(pathInScope(root, "lib/a.ts", scope)).toBe(false);
		expect(pathInScope(root, "src/../lib/a.ts", scope)).toBe(false);
		expect(pathInScope(root, "/etc/passwd", scope)).toBe(false);
		expect(pathInScope(root, "src/link/x.ts", scope)).toBe(false); // the symlink escapes the root
	});

	it("parseUnresolved: the trailing UNRESOLVED section, `none`, or not reported", () => {
		expect(parseUnresolved("did the work\n\nUNRESOLVED\n- could not run the tests\n- one type error left")).toEqual(["could not run the tests", "one type error left"]);
		expect(parseUnresolved("all done\n\nUNRESOLVED\nnone")).toEqual([]);
		expect(parseUnresolved("all done")).toBeNull();
		expect(parseUnresolved("## UNRESOLVED\n* a\n* b\n")).toEqual(["a", "b"]);
	});

	it("parseChangedFiles: numstat + name-status → additions, deletions, renames and binaries explicit", () => {
		const numstat = "3\t1\tsrc/a.ts\n-\t-\timg/logo.png\n0\t0\told.ts => new.ts\n";
		const nameStatus = "M\tsrc/a.ts\nA\timg/logo.png\nR100\told.ts\tnew.ts\n";
		expect(parseChangedFiles(numstat, nameStatus)).toEqual([
			{ path: "src/a.ts", status: "M", added: 3, removed: 1 },
			{ path: "img/logo.png", status: "A", binary: true },
			{ path: "new.ts", status: "R", from: "old.ts", added: 0, removed: 0 },
		]);
	});
});
