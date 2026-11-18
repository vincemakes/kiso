/**
 * R4 — the HTTP + SSE transport, end to end on a real socket.
 *
 * A node http server with the handler in front of a faux agent; a client
 * made of fetch and a hand-written SSE reader. The claims: authorize gates
 * everything and opens nothing; the stream frames every wire event under
 * its seq and carries the product's frames beside it; a client that drops
 * mid-run and reconnects with Last-Event-ID gets every wire event after it
 * exactly once; the refusals map to their codes; ?stream=1 returns the
 * run's own events and ends.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "@vincemakes/kiso-core";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { WireError } from "@vincemakes/kiso-protocol";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createSessionService } from "../src/index.js";
import { createHttpHandler, type HttpHandlerOptions } from "../src/http.js";

interface Frame {
	id?: string;
	event?: string;
	data?: unknown;
	comment?: string;
}

/** Parse SSE text into frames (blank-line separated). */
function parseSse(text: string): Frame[] {
	return text
		.split("\n\n")
		.filter((block) => block.trim() !== "")
		.map((block) => {
			const frame: Frame = {};
			for (const line of block.split("\n")) {
				if (line.startsWith(":")) frame.comment = line.slice(1).trim();
				else if (line.startsWith("id: ")) frame.id = line.slice(4);
				else if (line.startsWith("event: ")) frame.event = line.slice(7);
				else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
			}
			return frame;
		});
}

const callThen = (name: string): FauxScript => [
	{ events: [{ type: "tool_call_end", callId: "c1", name, input: { path: "x", prompt: "secret" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] },
];

function gatedTool(name: string) {
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const tool = defineTool({ name, description: name, parameters: { type: "object" }, execute: async () => { await gate; return { content: "ok", isError: false }; } });
	return { tool, release: () => release() };
}

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections(); // keep-alive sockets would hold close() for their idle timeout
		await new Promise<void>((r) => s.close(() => r()));
	}
});

async function host(opts: { script?: FauxScript; tools?: ReturnType<typeof defineTool>[]; defer?: string[]; handler?: Partial<HttpHandlerOptions> } = {}) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-http-")));
	let opened = 0;
	const service = createSessionService({
		store,
		open: async () => {
			opened += 1;
			return createAgent({
				model: "faux",
				store,
				tools: (opts.tools ?? []) as never,
				adapter: createFauxProvider(opts.script ?? callThen("t")),
				...(opts.defer !== undefined ? { permissionPolicy: { rules: opts.defer.map((tool) => ({ tool, action: "defer" as const })) } } : {}),
			});
		},
	});
	const { handle } = createHttpHandler(service, { authorize: () => true, keepaliveMs: 0, ...opts.handler });
	const server = createServer((req, res) => {
		void handle(req, res).then((handled) => {
			if (!handled) {
				res.writeHead(404);
				res.end("host route");
			}
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}/v1/sessions`;
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	return { store, service, base, post, opened: () => opened };
}

/** Read an SSE response until `stop` says so (or it ends); returns the frames. */
async function readSse(res: Response, stop?: (frames: Frame[]) => boolean): Promise<{ frames: Frame[]; abort: () => void }> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let frames: Frame[] = [];
	const abort = () => void reader.cancel().catch(() => {});
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
		frames = parseSse(text);
		if (stop?.(frames)) break;
	}
	return { frames, abort };
}

const events = (frames: Frame[]) => frames.filter((f) => f.id !== undefined);
const seqOf = (frames: Frame[]) => events(frames).map((f) => Number(f.id));

describe("R4: the HTTP + SSE transport", () => {
	it("authorize false → 403 and nothing is opened; a route outside the prefix is the host's", async () => {
		const h = await host({ handler: { authorize: () => false } });
		const res = await h.post("/s/run", { input: "hi" });
		expect(res.status).toBe(403);
		expect(((await res.json()) as WireError).code).toBe("forbidden");
		expect(h.opened()).toBe(0);
		expect((await fetch(`${h.base.replace("/v1/sessions", "/health")}`)).status).toBe(404);
	});

	it("run → 202; the stream frames every wire event under its seq, sanitizes tool arguments, carries the product's frames, and ends on nothing", async () => {
		const h = await host({
			tools: [defineTool({ name: "t", description: "t", parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) })],
			handler: { augment: (event) => (event.type === "terminal" ? [{ event: "billing", data: { cents: 3 } }] : []) },
		});
		const ran = await h.post("/s/run", { input: "go" });
		expect(ran.status).toBe(202);
		const { runId } = (await ran.json()) as { runId: string };
		expect(runId).toBeTruthy();
		await (await h.post("/s/run", { input: "go" })).text(); // in flight or already done — either way the log fills
		const res = await fetch(`${h.base}/s/events?after=-1`);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const { frames, abort } = await readSse(res, (fs) => fs.some((f) => f.event === "billing"));
		abort();
		expect(frames[0]!.comment).toBe("open");
		const wire = events(frames);
		expect(wire.map((f) => f.event)).toContain("tool_call_end");
		const call = wire.find((f) => f.event === "tool_call_end")!.data as { input: Record<string, unknown> };
		expect(call.input).toEqual({ path: "x" }); // prompt stripped
		expect(wire.some((f) => f.event === "usage")).toBe(false);
		expect(frames.find((f) => f.event === "billing")!.id).toBeUndefined(); // a product frame carries no seq
		expect(frames.at(-1)!.event).toBe("billing"); // right after the terminal it augments
	});

	it("a client that drops mid-run and reconnects with Last-Event-ID receives every wire event after it exactly once", async () => {
		const { tool, release } = gatedTool("slow");
		const h = await host({ script: callThen("slow"), tools: [tool] });
		await h.post("/s/run", { input: "go" });
		const first = await fetch(`${h.base}/s/events`);
		const a = await readSse(first, (fs) => fs.some((f) => f.event === "tool_execution_started"));
		a.abort(); // the client is gone, mid-run
		const lastSeen = Math.max(...seqOf(a.frames));
		release();
		await h.service.events("s"); // (no-op read; the run settles on its own)
		const second = await fetch(`${h.base}/s/events`, { headers: { "last-event-id": String(lastSeen) } });
		const b = await readSse(second, (fs) => fs.some((f) => f.event === "terminal"));
		b.abort();
		const replay = (await (await fetch(`${h.base}/s/replay`)).json()) as { events: { seq: number }[] };
		const all = replay.events.map((e) => e.seq);
		expect([...seqOf(a.frames), ...seqOf(b.frames)]).toEqual(all);
		expect(seqOf(b.frames)[0]).toBeGreaterThan(lastSeen);
		expect(new Set(seqOf(b.frames)).size).toBe(seqOf(b.frames).length);
	});

	it("an open run in the log → 409 open_run naming it; resumeFirst runs; the snapshot says so before and after", async () => {
		const h = await host({ script: [{ events: [{ type: "text_delta", text: "x" }, { type: "stop", reason: "end_turn" }] }] });
		await h.store.append("s", "r-dead", { seq: 0, type: "user_input", content: "before the crash" });
		const state = (await (await fetch(`${h.base}/s`)).json()) as { openRun: string | null; highWater: number };
		expect(state).toMatchObject({ openRun: "r-dead", highWater: 0 });
		const refused = await h.post("/s/run", { input: "next" });
		expect(refused.status).toBe(409);
		expect((await refused.json()) as WireError).toMatchObject({ code: "open_run", runId: "r-dead" });
		const streamed = await h.post("/s/run?stream=1", { input: "next", resumeFirst: true, after: -1 });
		const { frames } = await readSse(streamed);
		expect(events(frames).filter((f) => f.event === "terminal")).toHaveLength(2); // the dead run's, then this turn's — on ONE response, which then ended
		expect(((await (await fetch(`${h.base}/s/state`)).json()) as { openRun: unknown }).openRun).toBeNull();
	});

	// ADR-0038: uncertain belongs to the crash window. A call a live run is executing has started and not ended, and the
	// ledger counts it; the snapshot must not offer it for a verdict, and a verdict on it is refused.
	it("a call executing in a live run is not uncertain: the snapshot has none, a verdict is 409; after the run, still none", async () => {
		const gated = gatedTool("t");
		const h = await host({ tools: [gated.tool] });
		expect((await h.post("/s/run", { input: "go" })).status).toBe(202);
		const snap = async () => (await (await fetch(`${h.base}/s`)).json()) as { running: boolean; openRun: string | null; uncertain: unknown[] };
		for (let i = 0; i < 100 && !h.service.events("s").some((e) => e.type === "tool_execution_started"); i++) await new Promise((r) => setTimeout(r, 20));
		const [inFlight] = await h.service.uncertainExecutions("s"); // the ledger's view, which the transport must not pass on
		expect(inFlight).toBeDefined();
		expect(await snap()).toMatchObject({ running: true, uncertain: [] });
		const verdict = await h.post("/s/uncertain", { executionId: inFlight!.executionId, resolution: "rerun" });
		expect(verdict.status).toBe(409);
		expect((await verdict.json()) as WireError).toMatchObject({ code: "in_flight", message: "a run is live: its actions are not uncertain" });
		gated.release();
		for (let i = 0; i < 100 && (await snap()).running; i++) await new Promise((r) => setTimeout(r, 20));
		expect(await snap()).toMatchObject({ running: false, openRun: null, uncertain: [] });
		expect(h.service.events("s").some((e) => e.type === "tool_execution_resolved")).toBe(false); // no verdict was recorded
		expect(h.service.events("s").at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});

	it("the crash window still reports it: a started call in a run no process holds is uncertain, and a verdict is taken", async () => {
		const h = await host();
		await h.store.append("s", "r-dead", { seq: 0, type: "user_input", content: "go" });
		await h.store.append("s", "r-dead", { seq: 1, type: "tool_call_end", callId: "c1", name: "t", input: {} });
		await h.store.append("s", "r-dead", { seq: 2, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "t", input: {} });
		const state = (await (await fetch(`${h.base}/s`)).json()) as { running: boolean; openRun: string | null; uncertain: { executionId: string }[] };
		expect(state).toMatchObject({ running: false, openRun: "r-dead", uncertain: [{ executionId: "ex-1", callId: "c1", name: "t" }] });
		const verdict = await h.post("/s/uncertain", { executionId: "ex-1", resolution: "abandoned" });
		expect(verdict.status).toBe(200);
		expect(await verdict.json()).toEqual({ remaining: 0 });
	});

	it("a parked run: abort → 409 parked with the approval; approve → 200 needsResume false; then completed", async () => {
		const h = await host({
			script: callThen("deploy"),
			tools: [defineTool({ name: "deploy", description: "d", parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) })],
			defer: ["deploy"],
		});
		await h.post("/s/run", { input: "ship" });
		const pending = await readSse(await fetch(`${h.base}/s/events`), (fs) => fs.some((f) => f.event === "permission_requested"));
		pending.abort();
		const ask = pending.frames.find((f) => f.event === "permission_requested")!.data as { decisionId: string; input: Record<string, unknown> };
		expect(ask.input).toEqual({ path: "x" });
		const parked = await h.post("/s/abort", {});
		expect(parked.status).toBe(409);
		expect(await parked.json()).toMatchObject({ kind: "parked", approvals: [{ name: "deploy" }] });
		const approved = await h.post("/s/approve", { decisionId: ask.decisionId, allow: true });
		expect(approved.status).toBe(200);
		expect(await approved.json()).toEqual({ needsResume: false });
		const tail = await readSse(await fetch(`${h.base}/s/events`, { headers: { "last-event-id": "-1" } }), (fs) => fs.some((f) => f.event === "terminal"));
		tail.abort();
		expect(tail.frames.find((f) => f.event === "terminal")!.data).toMatchObject({ outcome: { kind: "completed" } });
		expect(await (await h.post("/s/abort", {})).json()).toEqual({ kind: "idle" });
	});

	it("a session id that starts with _ or - is routed (the store's own rule), a leading slash or a space is not", async () => {
		const h = await host({ script: [{ events: [{ type: "text_delta", text: "x" }, { type: "stop", reason: "end_turn" }] }] });
		for (const id of ["_abc", "-abc", "a.b-c_d"]) expect((await h.post(`/${id}/run`, { input: "go" })).status, id).toBe(202);
		expect((await fetch(`${h.base}/${encodeURIComponent("a b")}/state`)).status).toBe(404);
	});

	it("prepareInput may answer the request itself: the product's status and body, no run, nothing opened", async () => {
		const h = await host({
			handler: {
				prepareInput: (body, _req, _id, res) => {
					if (typeof body["input"] === "string" && body["input"].startsWith("!")) {
						res.writeHead(422, { "content-type": "application/json" });
						res.end(JSON.stringify({ code: "gate_closed", stage: "video" }));
						return { handled: true };
					}
					return body["input"] as string;
				},
			},
		});
		const refused = await h.post("/s/run", { input: "!render" });
		expect(refused.status).toBe(422);
		expect(await refused.json()).toEqual({ code: "gate_closed", stage: "video" });
		expect(h.opened()).toBe(0);
		expect(h.service.isRunning("s")).toBe(false);
		const ran = await h.post("/s/run", { input: "go" });
		expect(ran.status).toBe(202); // the same seam still prepares ordinary input
	});

	it("bad input → 400; unknown action → 404; draining → 503; GET on a POST route → 405", async () => {
		const h = await host();
		expect((await h.post("/s/run", { input: "" })).status).toBe(400);
		expect((await h.post("/s/run", { nope: 1 })).status).toBe(400);
		expect((await fetch(`${h.base}/s/whatever`)).status).toBe(404);
		expect((await fetch(`${h.base}/bad id/run`)).status).toBe(404);
		expect((await fetch(`${h.base}/s/run`)).status).toBe(405);
		await h.service.drain(10);
		const draining = await h.post("/t/run", { input: "x" });
		expect(draining.status).toBe(503);
		expect(((await draining.json()) as WireError).code).toBe("draining");
	});
});

describe("0.43.0 (#4): the host's own frame source rides the same ordered chain", () => {
	it("a frame pushed while a tool runs lands between the tool's started and result frames on /run?stream=1; the source is stopped when the stream ends", async () => {
		const gated = gatedTool("t");
		let push: ((frame: { event: string; data: unknown }) => void) | undefined;
		let stopped = 0;
		const h = await host({
			tools: [gated.tool],
			handler: {
				frames: (_sessionId, p) => {
					push = p;
					return () => {
						stopped += 1;
					};
				},
			},
		});
		const res = await h.post("/s/run?stream=1", { input: "hi" });
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const readUntil = async (stop: (frames: Frame[]) => boolean): Promise<Frame[]> => {
			for (;;) {
				const frames = parseSse(text);
				if (stop(frames)) return frames;
				const { value, done } = await reader.read();
				if (done) return parseSse(text);
				text += decoder.decode(value, { stream: true });
			}
		};
		await readUntil((fs) => fs.some((f) => f.event === "tool_execution_started"));
		expect(push, "the source was handed a push when the stream opened").toBeDefined();
		push!({ event: "progress", data: { pct: 37 } }); // minutes into a tool, nothing durable happening
		await readUntil((fs) => fs.some((f) => f.event === "progress"));
		gated.release();
		const frames = await readUntil((fs) => fs.some((f) => f.event === "terminal"));
		const order = frames.map((f) => f.event ?? (f.comment !== undefined ? `:${f.comment}` : "?"));
		const started = order.indexOf("tool_execution_started");
		const progress = order.indexOf("progress");
		const result = order.indexOf("tool_result");
		expect(started).toBeGreaterThan(-1);
		expect(progress, "the host's frame is on the stream").toBeGreaterThan(started);
		expect(result, "and before the durable event that came after it").toBeGreaterThan(progress);
		expect(frames.find((f) => f.event === "progress")!.data).toEqual({ pct: 37 });
		expect(frames.find((f) => f.event === "progress")!.id, "a host frame has no seq — it is not durable").toBeUndefined();
		await new Promise((r) => setTimeout(r, 30));
		expect(stopped, "the source is stopped when the stream ends").toBe(1);
	});

	it("GET /events carries the host's frames too; a push after the stream ended is dropped, not an error", async () => {
		const gated = gatedTool("t");
		const pushes: ((frame: { event: string; data: unknown }) => void)[] = [];
		const h = await host({ tools: [gated.tool], handler: { frames: (_s, p) => void pushes.push(p) } });
		expect((await h.post("/s/run", { input: "hi" })).status).toBe(202);
		const live = await fetch(`${h.base}/s/events`, { headers: { "last-event-id": "-1" } });
		const reader = live.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const readUntil = async (stop: (frames: Frame[]) => boolean): Promise<Frame[]> => {
			for (;;) {
				const frames = parseSse(text);
				if (stop(frames)) return frames;
				const { value, done } = await reader.read();
				if (done) return parseSse(text);
				text += decoder.decode(value, { stream: true });
			}
		};
		await readUntil((fs) => fs.some((f) => f.event === "tool_execution_started"));
		expect(pushes.length).toBeGreaterThan(0);
		for (const p of pushes) p({ event: "banner", data: { retry: 2 } });
		const frames = await readUntil((fs) => fs.some((f) => f.event === "banner"));
		expect(frames.find((f) => f.event === "banner")!.data).toEqual({ retry: 2 });
		await reader.cancel().catch(() => {});
		await new Promise((r) => setTimeout(r, 30));
		for (const p of pushes) p({ event: "late", data: 1 }); // the stream is gone — dropped
		gated.release();
	});
});
