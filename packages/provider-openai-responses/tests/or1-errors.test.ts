/**
 * OR-1 gate 3 — error mapping and cancellation.
 *
 * Classification is by STATUS CODE (ADR-0005), never by a regex over the
 * message. The two `Retry-After` forms both reach the kernel as
 * milliseconds, and the ChatGPT backend's quota facts (`plan_type`,
 * `resets_at`) land in the MESSAGE only — `resets_at` is when the plan's
 * window rolls over, not when this request may be retried, and handing it
 * to the kernel's backoff would park a session for hours.
 *
 * The cancel case asserts the thing that is easy to get wrong: after an
 * abort mid-stream the request is gone — the rig's socket is closed and
 * the abort listener is off the signal, so a long-lived signal does not
 * collect one listener per turn.
 */

import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { errorReply, hangReply, type Rig, sseReply, startRig } from "./helpers/rig.js";

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply([]));
});
afterEach(async () => {
	await rig.close();
});

async function drain(config: Parameters<typeof createOpenAIResponsesProvider>[0] = {}, signal?: AbortSignal): Promise<void> {
	const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl, ...config });
	for await (const _ of adapter.stream({
		model: "gpt-5.5",
		messages: [{ role: "user", content: "go" }],
		...(signal !== undefined ? { signal } : {}),
	})) void _;
}

describe("OR-1 errors — status in, StructuredError out", () => {
	it("429 with Retry-After in seconds → rate_limit, retryable, milliseconds", async () => {
		rig.reply = errorReply(429, '{"error":{"message":"too many"}}', { "retry-after": "3" });
		await expect(drain()).rejects.toMatchObject({ code: "rate_limit", retryable: true, status: 429, retryAfterMs: 3000 });
	});

	it("429 with retry-after-ms wins over Retry-After", async () => {
		rig.reply = errorReply(429, '{"error":{"message":"too many"}}', { "retry-after-ms": "1500", "retry-after": "60" });
		await expect(drain()).rejects.toMatchObject({ code: "rate_limit", retryAfterMs: 1500 });
	});

	it("429 with no Retry-After at all carries none — the kernel uses its own backoff", async () => {
		rig.reply = errorReply(429, '{"error":{"message":"too many"}}');
		const err = await drain().catch((e: unknown) => e);
		expect(err).toMatchObject({ code: "rate_limit", retryable: true });
		expect((err as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
	});

	it("401 → invalid_request, not retryable; on the ChatGPT target the message ends with the sign-in command", async () => {
		rig.reply = errorReply(401, '{"error":{"message":"invalid token"}}');
		await expect(drain()).rejects.toMatchObject({ code: "invalid_request", retryable: false, status: 401 });
		await expect(
			drain({ oauth: async () => ({ access: "tok", accountId: "acct" }) }),
		).rejects.toMatchObject({ message: expect.stringMatching(/run `kiso login chatgpt`$/) });
	});

	it("400 → invalid_request; 503 → api_5xx and retryable", async () => {
		rig.reply = errorReply(400, '{"error":{"message":"bad input"}}');
		await expect(drain()).rejects.toMatchObject({ code: "invalid_request", retryable: false, status: 400 });
		rig.reply = errorReply(503, "upstream down");
		await expect(drain()).rejects.toMatchObject({ code: "api_5xx", retryable: true, status: 503 });
	});

	it("the plan_type / resets_at facts ride the MESSAGE and never become retryAfterMs", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 42 * 60;
		rig.reply = errorReply(
			429,
			JSON.stringify({ error: { message: "usage limit reached", plan_type: "Plus", resets_at: resetsAt } }),
		);
		const err = await drain({ oauth: async () => ({ access: "tok", accountId: "acct" }) }).catch((e: unknown) => e);
		expect((err as { message: string }).message).toContain("usage limit reached");
		expect((err as { message: string }).message).toContain("plus plan");
		expect((err as { message: string }).message).toMatch(/resets in ~4[12] min/);
		expect((err as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
	});

	it("a non-JSON error body is reported verbatim rather than replaced by a guess", async () => {
		rig.reply = errorReply(500, "<html>gateway</html>");
		await expect(drain()).rejects.toMatchObject({ code: "api_5xx", message: expect.stringContaining("<html>gateway</html>") });
	});

	it("abort mid-stream ends the turn at once, with no stop event and no retryable error", async () => {
		rig.reply = hangReply(); // a response that would never finish on its own
		const controller = new AbortController();
		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		const seen: string[] = [];
		const pending = (async () => {
			for await (const ev of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }], signal: controller.signal })) seen.push(ev.type);
		})();
		await until(() => rig.openConnections() === 1); // the request is really in flight
		expect(rig.openConnections()).toBe(1);
		// CI-F1 (2026-09-10, the 0.32.1 release run): the rig records a request
		// when its BODY has been read (`req.on("end")`), while the connection
		// count moves on the TCP `connection` event. On a slow runner the
		// abort below cut the socket between the two, and the last assertion
		// found zero requests recorded for a request the server had indeed
		// received — a race in the rig's bookkeeping, not in the adapter.
		// The abort is meant to land on a request the server HAS; wait for it.
		await until(() => rig.requests.length === 1);
		const startedAt = Date.now();
		controller.abort();
		const err = await pending.then(() => null, (e: unknown) => e);
		// It ENDS — a hung stream that ignored the signal would sit here
		// until the test's own timeout.
		expect(Date.now() - startedAt).toBeLessThan(1000);
		// A cancellation is the CALLER's act: it must not arrive at the
		// kernel wearing `retryable: true`, or the loop retries a turn the
		// caller stopped; and it must not be dressed up as a clean stop.
		expect((err as { retryable?: boolean } | null)?.retryable).not.toBe(true);
		expect((err as Error).name).toBe("AbortError");
		expect(seen).not.toContain("stop");
		expect(rig.requests).toHaveLength(1);
	});

	it("a completed turn leaves NO listener of its OWN behind on a long-lived signal", async () => {
		rig.reply = sseReply([{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: null } }]);
		// The measurement has to be a DIFFERENCE: `fetch` itself keeps one
		// abort listener per request on the signal it was handed (measured
		// on this Node), so an absolute count of zero is unreachable and a
		// gate asserting it would only ever be testing undici. The
		// baseline is two bare fetches over one signal; the adapter's two
		// turns over its own signal must add nothing on top.
		const baseline = new AbortController();
		for (let i = 0; i < 2; i++) {
			const res = await fetch(`${rig.baseUrl}/responses`, { method: "POST", body: "{}", signal: baseline.signal });
			await res.text();
		}
		const control = new AbortController();
		await drain({}, control.signal);
		await drain({}, control.signal);
		expect(getEventListeners(control.signal, "abort")).toHaveLength(getEventListeners(baseline.signal, "abort").length);
	});
});

/** Poll until a condition holds — socket teardown is the kernel's and
 *  undici's timing, never a fixed sleep this test could get wrong. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}
