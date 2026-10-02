/**
 * Windows P3 — the hard-link guard on Windows.
 *
 * A file with more than one hard link is read only when every link is
 * verified inside the workspace — on POSIX by `find -inum`. On Windows
 * there is no such find: `find` there is C:\Windows\System32\find.exe, a
 * text search, so the scan failed and the file was refused as
 * "unverifiable" after running an unrelated program. The guard now
 * refuses without a scan there, and says why. A single-link file reads as
 * everywhere. Runs on every OS.
 */

import { linkSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { readFileTool } from "../src/index.js";

const CTX = { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} } } as unknown as ToolContext;
const realPlatform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }));

describe("a hard-linked file on Windows", () => {
	it("is refused without a scan, and the refusal says why", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-hardlink-"));
		writeFileSync(join(root, "a.txt"), "x");
		linkSync(join(root, "a.txt"), join(root, "b.txt"));
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const r = await readFileTool({ workspaceRoot: root }).execute({ path: "a.txt" }, CTX);
		expect(r.isError).toBe(true);
		expect(String(r.content)).toMatch(/hard link/);
		expect(String(r.content)).toMatch(/Windows/);
	});

	it("a file with one link reads (guard)", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-hardlink-"));
		writeFileSync(join(root, "one.txt"), "x");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const r = await readFileTool({ workspaceRoot: root }).execute({ path: "one.txt" }, CTX);
		expect(r.isError).toBe(false);
	});
});
