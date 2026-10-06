/**
 * Windows P3 — config paths are any absolute path for the host.
 *
 * `protectedPaths` and `evaluators` took only a path starting with `/` (or
 * `~/`), so on Windows every real path (`C:\Users\me\secrets.txt`) was
 * refused at load, and the first Windows CI run failed on it. They take
 * what the host calls absolute; a relative path is still refused (it would
 * mean a different file in every project), and a directory, spelled with
 * either separator, is still refused for protectedPaths.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const USER = "~/.kiso/config.json";
const realPlatform = process.platform;
beforeEach(() => Object.defineProperty(process, "platform", { value: "win32", configurable: true }));
afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }));

describe("config paths on Windows", () => {
	it("protectedPaths takes a drive path, with either separator", () => {
		for (const p of ["C:\\Users\\me\\secrets.txt", "C:/Users/me/secrets.txt", "D:\\keys\\api.key"]) {
			expect(parseConfig(JSON.stringify({ protectedPaths: [p] }), USER).protectedPaths).toEqual([p]);
		}
	});

	it("protectedPaths still refuses a relative path and a spelled directory", () => {
		expect(() => parseConfig(JSON.stringify({ protectedPaths: ["secrets\\x.txt"] }), USER)).toThrow(/expected an absolute path/);
		expect(() => parseConfig(JSON.stringify({ protectedPaths: ["C:x.txt"] }), USER)).toThrow(/expected an absolute path/);
		expect(() => parseConfig(JSON.stringify({ protectedPaths: ["C:\\Users\\me\\.aws\\"] }), USER)).toThrow(/is a directory/);
	});

	it("evaluators takes a drive path and refuses a relative one", () => {
		expect(parseConfig(JSON.stringify({ evaluators: ["C:\\tools\\eval.exe"] }), USER).evaluators).toEqual(["C:\\tools\\eval.exe"]);
		expect(() => parseConfig(JSON.stringify({ evaluators: ["tools\\eval.exe"] }), USER)).toThrow(/expected an absolute path/);
	});
});
