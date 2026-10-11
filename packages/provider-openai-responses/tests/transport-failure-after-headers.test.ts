/**
 * The transport-failure-after-headers class (0.39.1).
 *
 * Once a 2xx and the headers are in, the request has been ACCEPTED: no
 * later failure is a verdict on whether it was valid. What is left is the
 * server or the transport failing mid-flight, and the kernel's bounded
 * mid-stream retry (ADR-0005, F4: void the draft durably, then retry, cap
 * `maxRetries`) is the right answer — not an error terminal the human has
 * to restart by hand.
 *
 * This adapter already treated ONE member of the class that way: a socket
 * that DIES mid-stream (`toTransportError`). Four siblings did not, and
 * reached the run as `unknown / retryable:false`:
 *  1. an in-stream `error` frame;
 *  2. a `response.failed` frame;
 *  3. a frame whose payload is not JSON;
 *  4. a stream that ENDS with no terminal frame at all.
 *
 * The controls below are the other half: a failure the provider states
 * BEFORE the stream (a 400), and a terminal the provider actually sent,
 * both stay exactly as non-retryable as they were. The class is "after
 * the headers, without a verdict" — not "anything that goes wrong".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type AdapterEvent, type Event } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { errorReply, type Reply, type Rig, sseReply, startRig, truncatedReply } from "./helpers/rig.js";
import { seedLog } from "@vincemakes/kiso-runtime";

const PREFIX = [
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
	{ type: "response.output_text.delta", output_index: 0, delta: "half an answ" },
];

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply([]));
});
afterEach(async () => {
	await rig.close();
});

async function collect(): Promise<AdapterEvent[]> {
	const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
	const out: AdapterEvent[] = [];
	for await (const ev of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }] })) out.push(ev);
	return out;
}

/** A 200 whose body is valid SSE framing carrying a payload that is not
 *  JSON — a gateway writing its own error into an accepted stream. */
function garbageFrameReply(): Reply {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const ev of PREFIX) res.write(`data: ${JSON.stringify(ev)}\n\n`);
		res.write("data: <html>502 Bad Gateway</html>\n\n");
		res.end();
	};
}

describe("a failure AFTER the headers is retryable — the four siblings of the dead socket", () => {
	it("an in-stream error frame is a retryable network error, not an unknown terminal", async () => {
		rig.reply = sseReply([...PREFIX, { type: "error", code: "server_error", message: "the model exploded" }]);
		await expect(collect()).rejects.toMatchObject({
			code: "network",
			retryable: true,
			message: expect.stringContaining("the model exploded"),
		});
	});

	it("a response.failed frame is a retryable network error, and still carries the provider's reason", async () => {
		rig.reply = sseReply([...PREFIX, { type: "response.failed", response: { id: "r", status: "failed", error: { code: "server_error", message: "upstream gone" } } }]);
		await expect(collect()).rejects.toMatchObject({
			code: "network",
			retryable: true,
			message: expect.stringContaining("upstream gone"),
		});
	});

	it("a frame whose payload is not JSON is a retryable network error", async () => {
		rig.reply = garbageFrameReply();
		await expect(collect()).rejects.toMatchObject({
			code: "network",
			retryable: true,
			message: expect.stringContaining("502 Bad Gateway"),
		});
	});

	it("a stream that ENDS with no terminal frame THROWS retryable rather than stopping the run", async () => {
		// The socket is not destroyed: the response is ended cleanly, which
		// is what an intermediary does when its upstream dies after it has
		// already committed to a 200. Both protocols mandate a terminal
		// event, so a clean end without one is a protocol violation by
		// someone in the path — never the provider's considered verdict.
		rig.reply = truncatedReply(PREFIX, PREFIX.length);
		await expect(collect()).rejects.toMatchObject({ code: "network", retryable: true });
	});
});

describe("the controls — what this class does NOT reach", () => {
	it("a non-2xx BEFORE the stream keeps its status mapping and stays non-retryable", async () => {
		rig.reply = errorReply(400, '{"error":{"message":"bad input"}}');
		await expect(collect()).rejects.toMatchObject({ status: 400, code: "invalid_request", retryable: false });
	});

	it("a terminal the provider DID send stays a stop event, not a throw", async () => {
		// `response.incomplete` for a reason other than the output cap is an
		// error stop — the provider stated a verdict, so there is nothing to
		// retry and nothing to reclassify.
		rig.reply = sseReply([{ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [], usage: null } }]);
		const events = await collect();
		expect(events[events.length - 1]).toMatchObject({ type: "stop", reason: "error" });
	});
});

describe("the point of the class: the run RECOVERS instead of ending", () => {
	it("a turn whose stream ends with no terminal frame is retried, and the run completes", async () => {
		// The claim this whole round exists to make, run end to end through
		// the kernel rather than asserted about the adapter: first request
		// dies the way a gateway kills a long turn, second one answers.
		const good = [
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, delta: "the whole answer" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [] } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 3 } } },
		];
		let served = 0;
		rig.reply = (req, res) => {
			served += 1;
			(served === 1 ? truncatedReply(PREFIX, PREFIX.length) : sseReply(good))(req, res);
		};

		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		const out: Event[] = [];
		for await (const ev of loop({ adapter, model: "gpt-5.5", registry: new ToolRegistry(), log: seedLog([{ role: "user", content: "go" }]), maxRetries: 2 })) out.push(ev);

		expect(served).toBe(2);
		const terminal = out[out.length - 1] as { type: string; outcome?: { kind: string } };
		expect(terminal.outcome?.kind).toBe("completed");
		// The abandoned attempt is voided DURABLY (F4) — the half answer is
		// on the log as abandoned, not as history the next request replays.
		expect(out.some((e) => (e as { type: string }).type === "model_output_abandoned")).toBe(true);
	});
});
