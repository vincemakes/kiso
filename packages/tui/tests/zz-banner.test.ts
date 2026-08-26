import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { Screen } from "./helpers/screen.js";
describe("probe", () => {
	it("terminal state", () => {
		const raw = readFileSync("/private/tmp/claude-501/-Users-vinve-Desktop-devv-kiso/ac463155-3fd4-4b02-bffb-006f7b8d581a/scratchpad/banner.raw", "utf8");
		const s = new Screen(80, 14);
		s.feed(raw);
		const all = s.allLines().map((l) => l.replace(/\s+$/, ""));
		console.log("ON THE TERMINAL — session lines:", all.filter((l) => l.includes("session 20")).length);
		console.log("ON THE TERMINAL — version lines:", all.filter((l) => l.includes("the coding agent that survives")).length);
		console.log("ON THE TERMINAL — banner rows  :", all.filter((l) => l.includes("▀█▀")).length);
	});
});
