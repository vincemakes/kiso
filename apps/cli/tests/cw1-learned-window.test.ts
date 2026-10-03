import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextWindowTokens, knownContextWindow, statedContextWindow, windowLearnedNotice, windowSourceNote } from "../src/chat.js";
import { learnedKey, learnedWindowFor, recordLearnedWindow, resetLearnedWindows, useLearnedWindows } from "../src/learned-windows.js";
import { setAgentModel, setConfigModels, setConfiguredWindow } from "../src/state.js";

/** Mode bits are POSIX: Windows guards these files with ACLs, and Node reports 0666 there. */
const POSIX_MODES = process.platform !== "win32";

/**
 * CW-1 batch 2 — the CLI half: a refusal's cap is kept in
 * `<KISO_HOME>/learned-windows.json` and read first in the window chain,
 * after only what the user set. Every file here lives under a mkdtemp root;
 * nothing names the home directory.
 */

const FORWARDER = "http://127.0.0.1:47821/v1";
const DAY = new Date("2026-09-23T04:00:00Z");
let file: string;
let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env.KISO_CONTEXT_WINDOW;
	delete process.env.KISO_CONTEXT_WINDOW;
	file = join(mkdtempSync(join(tmpdir(), "kiso-cw1-learned-cli-")), "learned-windows.json");
	resetLearnedWindows();
	setConfiguredWindow(undefined);
	setConfigModels({});
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env.KISO_CONTEXT_WINDOW;
	else process.env.KISO_CONTEXT_WINDOW = savedEnv;
	resetLearnedWindows();
	setConfiguredWindow(undefined);
	setAgentModel("faux");
});

describe("the file keeps a refusal's cap, and only ever lowers it", () => {
	it("a new key is kept, privately; a larger figure changes nothing; a smaller one lowers it", () => {
		useLearnedWindows(file);
		expect(recordLearnedWindow("deepseek-v4.1-flash", FORWARDER, 1_048_576, DAY)).toBe(true);
		if (POSIX_MODES) expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [learnedKey("deepseek-v4.1-flash", FORWARDER)]: { tokens: 1_048_576, observedAt: "2026-09-23" } });
		expect(recordLearnedWindow("deepseek-v4.1-flash", FORWARDER, 2_000_000, DAY)).toBe(false);
		expect(learnedWindowFor("deepseek-v4.1-flash", FORWARDER)?.tokens).toBe(1_048_576);
		expect(recordLearnedWindow("deepseek-v4.1-flash", FORWARDER, 131_072, DAY)).toBe(true);
		expect(learnedWindowFor("deepseek-v4.1-flash", FORWARDER)?.tokens).toBe(131_072);
	});

	it("keyed by endpoint AND model; a trailing slash is the same endpoint", () => {
		useLearnedWindows(file);
		recordLearnedWindow("m", `${FORWARDER}/`, 100_000, DAY);
		expect(learnedWindowFor("m", FORWARDER)?.tokens).toBe(100_000);
		expect(learnedWindowFor("other-model", FORWARDER)).toBeUndefined();
		expect(learnedWindowFor("m", "https://elsewhere.example/v1")).toBeUndefined();
	});

	it("a later session reads what an earlier one kept; a corrupt file reads as empty and is replaced", () => {
		useLearnedWindows(file);
		recordLearnedWindow("m", FORWARDER, 100_000, DAY);
		resetLearnedWindows();
		useLearnedWindows(file);
		expect(learnedWindowFor("m", FORWARDER)?.tokens).toBe(100_000);
		writeFileSync(file, "{ not json");
		useLearnedWindows(file);
		expect(learnedWindowFor("m", FORWARDER)).toBeUndefined();
		expect(recordLearnedWindow("m", FORWARDER, 90_000, DAY)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))[learnedKey("m", FORWARDER)].tokens).toBe(90_000);
	});

	it("nothing is read or kept until startup names the file — library callers never touch a home directory", () => {
		expect(learnedWindowFor("m", FORWARDER)).toBeUndefined();
		expect(recordLearnedWindow("m", FORWARDER, 100_000, DAY)).toBe(false);
	});
});

describe("the chain: what you set, then what this endpoint refused at, then the registry", () => {
	it("a learned cap beats the model's inferred window — the status row and the tiers both move", () => {
		useLearnedWindows(file);
		setAgentModel("deepseek-v4.1-flash", FORWARDER);
		expect(statedContextWindow()?.source).toBe("model");
		recordLearnedWindow("deepseek-v4.1-flash", FORWARDER, 131_072, DAY);
		expect(statedContextWindow()).toEqual({ tokens: 131_072, source: "learned", observedAt: "2026-09-23" });
		expect(knownContextWindow()).toBe(131_072);
		expect(contextWindowTokens()).toBe(131_072);
		expect(windowSourceNote(statedContextWindow())).toBe("window 131,072, learned from this endpoint's refusal (2026-09-23)");
	});

	it("a figure the user set still wins over a learned one", () => {
		useLearnedWindows(file);
		recordLearnedWindow("deepseek-v4.1-flash", FORWARDER, 131_072, DAY);
		setAgentModel("deepseek-v4.1-flash", FORWARDER);
		setConfiguredWindow(1_048_576);
		expect(statedContextWindow()?.source).toBe("set");
		expect(contextWindowTokens()).toBe(1_048_576);
	});

	it("faux keeps its own 200,000 in the policy value — the fallback moving to 128K does not move it", () => {
		setAgentModel("faux");
		expect(contextWindowTokens()).toBe(200_000);
		expect(knownContextWindow()).toBe(200_000);
	});

	it("an unknown model falls back to 128K, and says so", () => {
		setAgentModel("unregistered-model-nobody-publishes-a-window-for", FORWARDER);
		expect(contextWindowTokens()).toBe(128_000);
		expect(windowSourceNote(statedContextWindow())).toBe("window unknown — compaction assumes 128K; set contextWindow on the profile to state it");
	});
});

describe("the notice, said once per new figure", () => {
	it("names the model, the host and the cap", () => {
		expect(windowLearnedNotice("deepseek-v4.1-flash", "127.0.0.1:47821", 131_072)).toBe("✦ window learned — 127.0.0.1:47821 refused deepseek-v4.1-flash past 131,072 tokens; compaction now aims below it");
		expect(windowLearnedNotice("m", "", 1_000_000)).toBe("✦ window learned — the endpoint refused m past 1M tokens; compaction now aims below it");
	});
});
