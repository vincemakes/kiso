/**
 * ADR-0057 §6 — steer on the hosted-session service and its HTTP transport.
 *
 * The service hands a person's input to the session's live run
 * (`Run.steer`), refuses with NotRunningError when nothing runs and with
 * the runtime's RunClosedError once the run's ingress has sealed, and
 * reports what never landed on `SettledRun.unadmitted`. On the wire:
 * `POST /:id/steer` answers 202 { runId } or 409 idle | closed, and a
 * stream that carries a run's terminal carries an `unadmitted` frame right
 * after it when input was accepted and never admitted — so a 202 always has
 * a visible fate.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool, type Event, type HookHost } from "@vincemakes/kiso-core";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { createAgent, RunClosedError, SessionStore } from "@vincemakes/kiso-runtime";
import { createSessionService, NotRunningError, type SettledRun } from "../src/index.js";
import { createHttpHandler } from "../src/http.js";

const callThen: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "slow", input: {} }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
];

function gatedTool() {
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let startedResolve: () => void = () => {};
	const started = new Promise<void>((r) => {
		startedResolve = r;
	});
	const tool = defineTool({
		name: "slow",
		description: "waits for the test",
		parameters: { type: "object" },
		execute: async () => {
			startedResolve();
			await gate;
			return { content: "ok", isError: false };
		},
	});
	return { tool, release: () => release(), started };
}

function harness(opts: { maxTurns?: number; hooks?: HookHost } = {}) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-steer-")));
	const gated = gatedTool();
	const settled: SettledRun[] = [];
	const service = createSessionService({
		store,
		open: async () =>
			createAgent({
				model: "faux",
				store,
				tools: [gated.tool],
				adapter: createFauxProvider(callThen),
				...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
				...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
			}),
		hooks: { onSettled: (s) => void settled.push(s) },
	});
	return { store, service, gated, settled };
}

const steerInputs = (events: readonly Event[], text: string) => events.filter((e) => e.type === "user_input" && e.content === text);

describe("ADR-0057 — SessionService.steer", () => {
	it("hands the live run a person's input; it lands in the same run", async () => {
		const { service, gated } = harness();
		const handle = await service.run("s", "go");
		await gated.started;
		expect(service.steer("s", "only the editor tests")).toEqual({ runId: handle.runId });
		gated.release();
		await handle.done;
		expect(steerInputs(service.events("s"), "only the editor tests")).toHaveLength(1);
		expect(service.events("s").filter((e) => e.type === "terminal")).toHaveLength(1);
	});

	it("refuses with NotRunningError when no run is live", async () => {
		const { service } = harness();
		expect(() => service.steer("s", "hello")).toThrow(NotRunningError);
	});

	it("refuses with RunClosedError once the live run's ingress has sealed", async () => {
		let refused: unknown;
		const box: { service?: ReturnType<typeof createSessionService> } = {};
		const { service, gated } = harness({
			hooks: {
				onStop: async () => {
					try {
						box.service!.steer("s", "during onStop");
					} catch (e) {
						refused = e;
					}
				},
			},
		});
		box.service = service;
		const handle = await service.run("s", "go");
		gated.release();
		await handle.done;
		expect(refused).toBeInstanceOf(RunClosedError);
	});

	it("reports input that never landed on SettledRun.unadmitted", async () => {
		const { service, gated, settled } = harness({ maxTurns: 1 });
		const handle = await service.run("s", "go");
		await gated.started;
		service.steer("s", "too late");
		gated.release();
		await handle.done;
		expect(settled.at(-1)?.outcome).toBe("max_turns");
		expect(settled.at(-1)?.unadmitted).toEqual(["too late"]);
		expect(steerInputs(service.events("s"), "too late")).toHaveLength(0);
	});
});

// ── the HTTP transport ────────────────────────────────────────────────────

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		await new Promise<void>((r) => s.close(() => r()));
	}
});

async function host(opts: { maxTurns?: number } = {}) {
	const h = harness(opts);
	const { handle } = createHttpHandler(h.service, { authorize: () => true, keepaliveMs: 0 });
	const server = createServer((req, res) => {
		void handle(req, res).then((handled) => {
			if (!handled) {
				res.writeHead(404);
				res.end();
			}
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/sessions`;
	const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { ...h, post };
}

/** The SSE frames of a finished stream. */
async function framesOf(res: Response): Promise<{ event?: string; data?: unknown }[]> {
	const text = await res.text();
	return text
		.split("\n\n")
		.filter((b) => b.trim() !== "" && !b.startsWith(":"))
		.map((block) => {
			const frame: { event?: string; data?: unknown } = {};
			for (const line of block.split("\n")) {
				if (line.startsWith("event: ")) frame.event = line.slice(7);
				else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
			}
			return frame;
		});
}

describe("ADR-0057 — POST /:id/steer and the unadmitted frame", () => {
	it("202 { runId } while a run is live; 409 idle when none is", async () => {
		const h = await host();
		const idle = await h.post("/s/steer", { input: "hello" });
		expect(idle.status).toBe(409);
		expect(await idle.json()).toMatchObject({ code: "idle" });

		const run = await h.post("/s/run", { input: "go" });
		const { runId } = (await run.json()) as { runId: string };
		await h.gated.started;
		const steered = await h.post("/s/steer", { input: "only the editor tests" });
		expect(steered.status).toBe(202);
		expect(await steered.json()).toEqual({ runId });
		h.gated.release();
	});

	it("a stream carries an `unadmitted` frame right after the terminal when an accepted steer never landed", async () => {
		const h = await host({ maxTurns: 1 });
		const streamed = h.post("/s/run?stream=1", { input: "go" });
		await h.gated.started;
		const steered = await h.post("/s/steer", { input: "too late" });
		expect(steered.status).toBe(202);
		const { runId } = (await steered.json()) as { runId: string };
		h.gated.release();
		const frames = await framesOf(await streamed);
		const at = frames.findIndex((f) => f.event === "terminal");
		expect(at).toBeGreaterThan(-1);
		expect(frames[at + 1]).toEqual({ event: "unadmitted", data: { runId, items: ["too late"] } });
	});

	it("no `unadmitted` frame when everything accepted was admitted", async () => {
		const h = await host();
		const streamed = h.post("/s/run?stream=1", { input: "go" });
		await h.gated.started;
		expect((await h.post("/s/steer", { input: "landed" })).status).toBe(202);
		h.gated.release();
		const frames = await framesOf(await streamed);
		expect(frames.some((f) => f.event === "unadmitted")).toBe(false);
	});
});
