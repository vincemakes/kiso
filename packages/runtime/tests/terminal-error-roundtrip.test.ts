/**
 * 0.43.0 (#19) — the kernel never writes a terminal the store cannot read.
 *
 * toStructuredError passed any string through as the error code; the
 * durable protocol's ErrorCode is a closed set of nine and the store's
 * load validates against it — so a host adapter's vendor code
 * ("ECONNRESET") produced a session kiso itself could never read back
 * ("line N is not a session record"). RED on 0.42.x: the load throws.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isKisoEvent, type Adapter, type AdapterEvent, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

function throwing(err: unknown): Adapter {
	return {
		stream: async function* (): AsyncIterable<AdapterEvent> {
			throw err;
			yield undefined as never;
		},
	};
}

async function terminalOf(err: unknown): Promise<{ terminal: Event & { type: "terminal" }; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "kiso-errcode-"));
	const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [], adapter: throwing(err), maxRetries: 0 });
	const session = await agent.session({ id: "s" });
	const events: Event[] = [];
	for await (const ev of session.run("go")) events.push(ev);
	await agent.close();
	return { terminal: events.find((e) => e.type === "terminal") as Event & { type: "terminal" }, dir };
}

describe("0.43.0 (#19): a host adapter's error is normalized to the durable schema before the terminal is written", () => {
	it("a vendor code becomes \"unknown\" with the code kept in the message; retryable rides as given; the session loads back", async () => {
		const { terminal, dir } = await terminalOf({ code: "ECONNRESET", retryable: true, message: "socket reset" });
		expect(terminal.outcome.kind).toBe("error");
		const error = (terminal.outcome as { error: { code: string; message: string; retryable: boolean } }).error;
		expect(error.code).toBe("unknown");
		expect(error.message).toBe("[ECONNRESET] socket reset");
		expect(error.retryable).toBe(true);
		// the whole point: the store reads its own record back
		const records = new SessionStore(dir).load("s");
		expect(records.every((r) => isKisoEvent(r.event))).toBe(true);
		expect(records.at(-1)!.event.type).toBe("terminal");
	});

	it("a known code stays itself, and a status outside the non-negative safe integers is dropped", async () => {
		const { terminal, dir } = await terminalOf({ code: "network", retryable: false, message: "gone", status: -1 });
		const error = (terminal.outcome as { error: { code: string; message: string; status?: number } }).error;
		expect(error.code).toBe("network");
		expect(error.message).toBe("gone");
		expect("status" in error).toBe(false);
		expect(new SessionStore(dir).load("s").every((r) => isKisoEvent(r.event))).toBe(true);
		const ok = await terminalOf({ code: "api_5xx", retryable: true, message: "bad gateway", status: 502 });
		expect((ok.terminal.outcome as { error: { status?: number } }).error.status).toBe(502);
	});
});
