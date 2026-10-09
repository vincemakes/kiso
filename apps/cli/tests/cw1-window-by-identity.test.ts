import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextWindowTokens, knownContextWindow, microcompactThresholdFor, statedContextWindow, windowLabel, windowSourceNote } from "../src/chat.js";
import { setAgentModel, setConfigModels, setConfiguredWindow, upstreamOf } from "../src/state.js";

/**
 * CW-1 (owner, 2026-09-23) — the CLI half: the chain the status row, the
 * compaction tiers and the /model rows read, and the words that name its
 * source. The owner's case: the `op` profile, `deepseek-v4.1-flash` at a
 * local forwarder to a model gateway, read `ctx ?` and compacted against 200K.
 */

const FORWARDER = "http://127.0.0.1:47821/v1";
const op = { kind: "openai-compat" as const, model: "deepseek-v4.1-flash", apiKeyEnv: "K", baseUrl: FORWARDER, upstream: "https://gateway.example/v1" };
let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env.KISO_CONTEXT_WINDOW;
	delete process.env.KISO_CONTEXT_WINDOW;
	setConfiguredWindow(undefined);
	setConfigModels({ op });
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env.KISO_CONTEXT_WINDOW;
	else process.env.KISO_CONTEXT_WINDOW = savedEnv;
	setConfiguredWindow(undefined);
	setConfigModels({});
	setAgentModel("faux");
});

describe("the op profile gets a window, and says whose it is", () => {
	it("the status row's denominator AND the tiers' window are the model's 1M — not ? and not 200K", () => {
		setAgentModel(op.model, op.baseUrl);
		expect(knownContextWindow()).toBe(1_000_000);
		expect(contextWindowTokens()).toBe(1_000_000);
		expect(microcompactThresholdFor()).toBe(500_000);
		expect(statedContextWindow()).toEqual({ tokens: 1_000_000, source: "model", from: "deepseek-flash" });
	});

	it("the source is said: inferred from the model, not stated for this endpoint (0.40.6, declared re-pin: the short /model-row form is retired with its caller)", () => {
		setAgentModel(op.model, op.baseUrl);
		expect(windowSourceNote(statedContextWindow())).toBe("window 1M, inferred from the model (deepseek-flash) — not stated for this endpoint");
	});

	it("a figure the user set wins, and is said as theirs", () => {
		setAgentModel(op.model, op.baseUrl);
		setConfiguredWindow(1_048_576);
		expect(statedContextWindow()).toEqual({ tokens: 1_048_576, source: "set" });
		expect(windowSourceNote(statedContextWindow())).toBe("window 1,048,576, as you set it");
	});

	it("a /model row reads with its OWN configured figure, not the live one", () => {
		setAgentModel("faux");
		setConfiguredWindow(1_048_576); // the live binding's
		// red before the fix: an optional parameter defaulted to the live
		// figure took it back on an explicit undefined — every row without
		// its own window read the live profile's, "as you set it"
		expect(statedContextWindow({ model: op.model, baseUrl: op.baseUrl, upstream: op.upstream }, { configured: undefined })?.source).toBe("model");
		expect(statedContextWindow({ model: op.model, baseUrl: op.baseUrl, upstream: op.upstream }, { configured: 900_000 })).toEqual({ tokens: 900_000, source: "set" });
	});
});

describe("the forwarder's upstream is found by its address", () => {
	it("a resumed binding (no profile name in hand) still finds it", () => {
		expect(upstreamOf(FORWARDER)).toBe("https://gateway.example/v1");
		expect(upstreamOf("http://127.0.0.1:1/v1")).toBeUndefined();
		expect(upstreamOf(undefined)).toBeUndefined();
	});

	it("an upstream with a row of its own decides ahead of the model's smallest", () => {
		setConfigModels({ fwd: { kind: "openai-compat", model: "gpt-5.5", apiKeyEnv: "K", baseUrl: FORWARDER, upstream: "https://api.openai.com/v1" } });
		setAgentModel("gpt-5.5", FORWARDER);
		expect(statedContextWindow()).toEqual({ tokens: 1_050_000, source: "upstream", from: "gpt-5.5" });
		expect(contextWindowTokens()).toBe(1_050_000);
		setConfigModels({});
		expect(statedContextWindow(), "without the upstream, the smaller of the two rows").toEqual({ tokens: 272_000, source: "model", from: "gpt-5.5" });
	});
});

describe("unknown stays unknown — and says what it assumes", () => {
	it("no row, no figure: ? on the row, the fallback for the tiers, said in words", () => {
		setAgentModel("unregistered-model-nobody-publishes-a-window-for", FORWARDER);
		expect(knownContextWindow()).toBeNull();
		expect(contextWindowTokens()).toBe(200_000); // declared re-pin (the owner, 2026-10-09): the fallback is 200K again, reversing CW-1 batch 2's 128K
		expect(windowSourceNote(statedContextWindow())).toBe("window unknown — compaction assumes 200K; set contextWindow on the profile to state it");
	});

	it("the route's own row is named as the registry's", () => {
		setAgentModel("deepseek-flash", "https://api.deepseek.com");
		expect(windowSourceNote(statedContextWindow())).toBe("window 1M, the registry's for this endpoint");
	});
});

describe("window figures as the displays write them", () => {
	it("round figures short, a figure that is not round whole", () => {
		expect(windowLabel(1_000_000)).toBe("1M");
		expect(windowLabel(1_050_000)).toBe("1.05M");
		expect(windowLabel(272_000)).toBe("272K");
		expect(windowLabel(200_000)).toBe("200K");
		expect(windowLabel(1_048_576)).toBe("1,048,576");
	});
});
