/**
 * R5 — the client against the real transport on a real socket.
 *
 * The claims: the calls map to the routes and the refusals to ClientError;
 * a parked abort is a reply; `events()` survives the SERVER cutting every
 * connection mid-run — it reconnects with Last-Event-ID and the consumer
 * sees every wire event after its `after` exactly once; `runStream()`
 * carries one turn on one response; the SSE parser handles split chunks
 * and multi-line data.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "@vincemakes/kiso-core";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createSessionService } from "@vincemakes/kiso-server";
import { createHttpHandler } from "@vincemakes/kiso-server/http";
import { ClientError, createClient, parseSseBlock, readSse, type ClientEvent } from "../src/index.js";

const callThen = (name: string): FauxScript => [
	{ events: [{ type: "tool_call_end", callId: "c1", name, input: { path: "x" } }, { type: "stop", reason: "tool_use" }] },
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

const instant = (name: string) => defineTool({ name, description: name, parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) });

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		await new Promise<void>((r) => s.close(() => r()));
	}
});

async function host(opts: { script?: FauxScript; tools?: ReturnType<typeof instant>[]; defer?: string[]; authorize?: () => boolean } = {}) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-client-")));
	const service = createSessionService({
		store,
		open: async () =>
			createAgent({
				model: "faux",
				store,
				tools: (opts.tools ?? []) as never,
				adapter: createFauxProvider(opts.script ?? callThen("t")),
				...(opts.defer !== undefined ? { permissionPolicy: { rules: opts.defer.map((tool) => ({ tool, action: "defer" as const })) } } : {}),
			}),
	});
	const { handle } = createHttpHandler(service, {
		authorize: opts.authorize ?? (() => true),
		keepaliveMs: 0,
		augment: (event) => (event.type === "terminal" ? [{ event: "billing", data: { cents: 1 } }] : []),
	});
	const server = createServer((req, res) => void handle(req, res).then((h) => h || (res.writeHead(404), res.end())));
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as { port: number }).port;
	const client = createClient({ baseUrl: `http://127.0.0.1:${port}/v1/sessions`, reconnect: { initialMs: 20, maxMs: 50 } });
	return { store, service, server, client, session: client.session("s") };
}

const seqs = (evs: readonly ClientEvent[]) => evs.filter((e) => e.kind === "event").map((e) => (e as { event: { seq: number } }).event.seq);
const terminal = (e: ClientEvent) => e.kind === "event" && e.event.type === "terminal";

describe("R5: the client", () => {
	it("run → runId; events() delivers the turn under seq with the product's frame; a parked abort is a reply; approve continues", async () => {
		const h = await host({ script: callThen("deploy"), tools: [instant("deploy")], defer: ["deploy"] });
		const { runId } = await h.session.run("ship");
		expect(runId).toBeTruthy();
		const seen: ClientEvent[] = [];
		for await (const ev of h.session.events({ until: (e) => e.kind === "event" && e.event.type === "permission_requested" })) seen.push(ev);
		const ask = seen.at(-1)!;
		expect(ask.kind === "event" && ask.event.type === "permission_requested" && ask.event.input).toEqual({ path: "x" });
		const parked = await h.session.abort();
		expect(parked.kind).toBe("parked");
		const decisionId = (ask as { event: { decisionId: string } }).event.decisionId;
		expect(await h.session.approve(decisionId, true, "ok")).toEqual({ needsResume: false });
		const rest: ClientEvent[] = [];
		for await (const ev of h.session.events({ after: Math.max(...seqs(seen)), until: (e) => e.kind === "frame" && e.event === "billing" })) rest.push(ev);
		expect(rest.some(terminal)).toBe(true);
		expect(rest.at(-1)).toEqual({ kind: "frame", event: "billing", data: { cents: 1 } });
		expect([...seqs(seen), ...seqs(rest)]).toEqual((await h.session.replay()).events.map((e) => e.seq));
		expect(await h.session.abort()).toEqual({ kind: "idle" });
	});

	it("events() survives the server cutting the connection mid-run: reconnects with Last-Event-ID, every event after `after` exactly once", async () => {
		const { tool, release } = gatedTool("slow");
		const h = await host({ script: callThen("slow"), tools: [tool] });
		await h.session.run("go");
		const seen: ClientEvent[] = [];
		const reconnects: number[] = [];
		const consumer = (async () => {
			for await (const ev of h.session.events({ until: terminal, onReconnect: (n) => void reconnects.push(n) })) {
				seen.push(ev);
				if (ev.kind === "event" && ev.event.type === "tool_execution_started") {
					h.server.closeAllConnections(); // the server drops every client — mid-run, mid-stream
					setTimeout(release, 30); // the tool returns after the drop; the rest of the run lands on the NEW connection
				}
			}
		})();
		await consumer;
		expect(reconnects.length).toBeGreaterThanOrEqual(1);
		const all = (await h.session.replay()).events.map((e) => e.seq);
		expect(seqs(seen)).toEqual(all); // every wire event, once, in order — across the cut
		expect((await h.session.state()).running).toBe(false);
	});

	it("runStream() carries one turn on one response, including a resumed open run first", async () => {
		const h = await host({ script: [{ events: [{ type: "text_delta", text: "x" }, { type: "stop", reason: "end_turn" }] }] });
		await h.store.append("s", "r-dead", { seq: 0, type: "user_input", content: "before the crash" });
		expect((await h.session.state()).openRun).toBe("r-dead");
		const refused = await h.session.run("next").catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(ClientError);
		expect((refused as ClientError).code).toBe("open_run");
		expect((refused as ClientError).runId).toBe("r-dead");
		const seen: ClientEvent[] = [];
		for await (const ev of h.session.runStream("next", { resumeFirst: true })) seen.push(ev);
		expect(seen.filter(terminal)).toHaveLength(2);
		expect((await h.session.state()).openRun).toBeNull();
	});

	it("refusals are ClientError with the wire's code: forbidden opens nothing, in_flight names the run, draining", async () => {
		const forbidden = await host({ authorize: () => false });
		const err = await forbidden.session.run("hi").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ClientError);
		expect((err as ClientError).status).toBe(403);
		expect((err as ClientError).code).toBe("forbidden");
		const { tool, release } = gatedTool("slow");
		const h = await host({ script: callThen("slow"), tools: [tool] });
		const { runId } = await h.session.run("go");
		for await (const _ of h.session.events({ until: (e) => e.kind === "event" && e.event.type === "tool_execution_started" })) void _;
		const inFlight = await h.session.run("again").catch((e: unknown) => e as ClientError);
		expect(inFlight).toMatchObject({ code: "in_flight", status: 409, runId });
		release();
		for await (const _ of h.session.events({ until: terminal })) void _;
		await h.service.drain(10);
		expect(((await h.client.session("t").run("x").catch((e: unknown) => e)) as ClientError).code).toBe("draining");
	});

	it("the SSE parser: split chunks, multi-line data, CRLF, comments", async () => {
		const text = "id: 7\r\nevent: text_delta\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n: keepalive\n\ndata: {\"b\":2}\n\n";
		const chunks = [text.slice(0, 5), text.slice(5, 23), text.slice(23)].map((s) => new TextEncoder().encode(s));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
				controller.close();
			},
		});
		const frames = [];
		for await (const f of readSse(body)) frames.push(f);
		expect(frames).toEqual([{ id: "7", event: "text_delta", data: '{"a":\n1}' }, { comment: "keepalive" }, { data: '{"b":2}' }]);
		expect(parseSseBlock("")).toBeNull();
	});
});

describe("0.43.0: the client surfaces the transport's comments", () => {
	it("runStream() yields `: open` as a comment event before the turn's first event — a quiet stream is distinguishable from a dead one", async () => {
		const h = await host();
		const kinds: string[] = [];
		for await (const ev of h.session.runStream("hi")) {
			kinds.push(ev.kind === "comment" ? `:${ev.comment}` : ev.kind);
			if (ev.kind === "event" && ev.event.type === "terminal") break;
		}
		expect(kinds[0]).toBe(":open");
		expect(kinds).toContain("event");
	});
});

describe("ADR-0057: steer", () => {
	it("steer → { runId } while a run is live and the input lands in that run; ClientError `idle` when none is", async () => {
		const { tool, release } = gatedTool("slow");
		const h = await host({ script: callThen("slow"), tools: [tool as never] });
		let idle: unknown;
		try {
			await h.session.steer("hello");
		} catch (e) {
			idle = e;
		}
		expect(idle).toBeInstanceOf(ClientError);
		expect((idle as ClientError).code).toBe("idle");

		const { runId } = await h.session.run("go");
		expect(await h.session.steer("only the editor tests")).toEqual({ runId });
		release();
		for await (const _ of h.session.events({ until: terminal })) {
			/* until the run's terminal */
		}
		expect(h.service.events("s").some((e) => e.type === "user_input" && e.content === "only the editor tests")).toBe(true);
	});
});
