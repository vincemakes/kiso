/**
 * The session store's two durability classes (ADR-0025 Decision 5 and
 * ADR-0052, their 2026-09-29 amendments).
 *
 * A model streaming a large tool argument produces tens of thousands of
 * `tool_call_input_delta` events in one turn, and the store synced each
 * one before returning — minutes of fsync for a single turn. A streamed
 * fragment (`text_delta`, `thinking`, `tool_call_input_delta`) is now
 * written without its own sync; every other event is written and synced
 * as before, and that sync makes the fragments before it durable.
 *
 * The gate is deterministic: it counts `fsyncSync` per append on the
 * session file (by fd, so lock and directory syncs never blur it), never a
 * wall clock. Load stays strict and is not touched here.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const FRAGMENTS = new Set(["text_delta", "thinking", "tool_call_input_delta"]);

/** Every store append and every sync, in order, with its fd; and two
 *  injectable failures. */
const io = vi.hoisted(() => ({
	log: [] as { op: "append" | "sync"; fd: number; type?: string }[],
	failAppendOf: null as string | null,
	failSyncAfter: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const lastType = new Map<number, string>();
	return {
		...real,
		appendFileSync: (fd: unknown, data: unknown, ...rest: unknown[]) => {
			if (typeof fd === "number" && typeof data === "string") {
				let type: string | undefined;
				try {
					type = (JSON.parse(data) as { event?: { type?: string } }).event?.type;
				} catch {
					type = undefined;
				}
				if (type !== undefined) {
					if (io.failAppendOf === type) throw new Error(`injected write failure: ${type}`);
					io.log.push({ op: "append", fd, type });
					lastType.set(fd, type);
				}
			}
			return (real.appendFileSync as (...a: unknown[]) => void)(fd, data, ...rest);
		},
		fsyncSync: (fd: number) => {
			if (io.failSyncAfter !== null && lastType.get(fd) === io.failSyncAfter) {
				throw new Error(`injected sync failure after ${io.failSyncAfter}`);
			}
			io.log.push({ op: "sync", fd });
			return real.fsyncSync(fd);
		},
	};
});

/** Per store append on the session file: its event type and the syncs of
 *  that same fd that follow it before the next append. */
function syncsPerAppend(): { type: string; syncs: number }[] {
	const out: { type: string; syncs: number }[] = [];
	let fd: number | undefined;
	for (const entry of io.log) {
		if (entry.op === "append") {
			fd ??= entry.fd;
			if (entry.fd === fd) out.push({ type: entry.type!, syncs: 0 });
		} else if (entry.fd === fd && out.length > 0) {
			out[out.length - 1]!.syncs += 1;
		}
	}
	return out;
}

beforeEach(() => {
	io.log.length = 0;
	io.failAppendOf = null;
	io.failSyncAfter = null;
});

/** A model that thinks, streams a call's arguments in pieces, then answers in text. */
function streamingModel(): Adapter {
	let n = 0;
	return {
		stream: async function* (): AsyncIterable<AdapterEvent> {
			n += 1;
			if (n === 1) {
				yield { seq: 0, type: "thinking", text: "plan " };
				yield { seq: 0, type: "thinking", text: "the call" };
				yield { seq: 0, type: "tool_call_start", callId: "c1", name: "probe" };
				for (const piece of ['{"x":', "5", "}"]) yield { seq: 0, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: piece };
				yield { seq: 0, type: "tool_call_end", callId: "c1", name: "probe", input: { x: 5 } };
				yield { seq: 0, type: "stop", reason: "tool_use" };
			} else {
				yield { seq: 0, type: "text_delta", text: "do" };
				yield { seq: 0, type: "text_delta", text: "ne" };
				yield { seq: 0, type: "stop", reason: "end_turn" };
			}
		},
	};
}

let handlerCalls = 0;
const probe = defineTool({
	name: "probe",
	description: "counts its calls",
	parameters: { type: "object", properties: { x: { type: "number" } } },
	execute: async () => {
		handlerCalls += 1;
		return { content: "ok", isError: false };
	},
});

async function runOnce(): Promise<{ events: Event[]; error: unknown }> {
	handlerCalls = 0;
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fsync-classes-")));
	const agent = createAgent({ model: "faux", store, tools: [probe], adapter: streamingModel() });
	const session = await agent.session({ id: "s" });
	const events: Event[] = [];
	let error: unknown;
	try {
		for await (const e of session.run("go")) events.push(e);
	} catch (err) {
		error = err;
	}
	agent.close();
	return { events, error };
}

describe("the store's durability classes — a fragment is written, everything else is written and synced", () => {
	it("appended directly: each fragment 0 syncs, each other event exactly 1; deltas → tool_call_end and fragments → stop each cost one sync", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fsync-classes-")));
		const sequence: Record<string, unknown>[] = [
			{ type: "user_input", content: "go" },
			{ type: "tool_call_start", callId: "c1", name: "probe" },
			{ type: "tool_call_input_delta", callId: "c1", inputJsonDelta: '{"x":' },
			{ type: "tool_call_input_delta", callId: "c1", inputJsonDelta: "5}" },
			{ type: "tool_call_end", callId: "c1", name: "probe", input: { x: 5 } },
			{ type: "thinking", text: "then " },
			{ type: "text_delta", text: "do" },
			{ type: "text_delta", text: "ne" },
			{ type: "stop", reason: "end_turn" },
		];
		for (const [i, e] of sequence.entries()) await store.append("s", "r1", { ...e, seq: i } as unknown as Event);
		store.closeAll();
		const rows = syncsPerAppend();
		expect(rows.map((r) => r.type)).toEqual(sequence.map((e) => e.type));
		for (const r of rows) expect(r.syncs, r.type).toBe(FRAGMENTS.has(r.type) ? 0 : 1);
	});

	it("a real run: every event type the loop writes follows the rule, fragments of all three kinds included", async () => {
		const { events, error } = await runOnce();
		expect(error).toBeUndefined();
		expect(handlerCalls).toBe(1);
		const rows = syncsPerAppend();
		expect(rows.length).toBe(events.length);
		const types = new Set(rows.map((r) => r.type));
		for (const t of FRAGMENTS) expect(types.has(t), t).toBe(true);
		for (const t of ["user_input", "tool_call_end", "stop", "tool_execution_started", "tool_result", "terminal"]) expect(types.has(t), t).toBe(true);
		for (const r of rows) expect(r.syncs, r.type).toBe(FRAGMENTS.has(r.type) ? 0 : 1);
	});

	it("a fragment whose write fails still fails the append — a skipped sync is not fire-and-forget", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fsync-classes-")));
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" } as Event);
		io.failAppendOf = "text_delta";
		await expect(store.append("s", "r1", { seq: 1, type: "text_delta", text: "x" } as Event)).rejects.toThrow(/injected write failure/);
		store.closeAll();
	});

	it("a failed sync of tool_execution_started: the handler never starts", async () => {
		io.failSyncAfter = "tool_execution_started";
		const { events, error } = await runOnce();
		expect(handlerCalls).toBe(0);
		const completed = events.some((e) => e.type === "terminal" && (e as { outcome?: { kind?: string } }).outcome?.kind === "completed");
		expect(error !== undefined || !completed).toBe(true);
	});

	it("a failed sync of the receipt surfaces as a failure, never as a completed run", async () => {
		io.failSyncAfter = "tool_execution_succeeded";
		const { events, error } = await runOnce();
		const completed = events.some((e) => e.type === "terminal" && (e as { outcome?: { kind?: string } }).outcome?.kind === "completed");
		expect(error !== undefined || !completed).toBe(true);
	});
});

describe("kill -9 loses nothing written: unsynced fragments are in the OS page cache, not the process", () => {
	it("a writer that appends fragments and is then SIGKILLed leaves every one of them on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-fsync-kill-"));
		const N = 200;
		const writer = `
import { SessionStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const store = new SessionStore(${JSON.stringify(dir)});
await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
await store.append("s", "r1", { seq: 1, type: "tool_call_start", callId: "c1", name: "probe" });
for (let i = 0; i < ${N}; i++) await store.append("s", "r1", { seq: 2 + i, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: String(i % 10) });
process.kill(process.pid, "SIGKILL");
`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", writer], { stdio: "ignore" });
		const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, sig) => resolve(sig)));
		expect(signal).toBe("SIGKILL");
		const records = new SessionStore(dir).load("s");
		expect(records).toHaveLength(N + 2);
		const deltas = records.map((r) => r.event).filter((e) => e.type === "tool_call_input_delta");
		expect(deltas.map((e) => (e as { inputJsonDelta: string }).inputJsonDelta).join("")).toBe(Array.from({ length: N }, (_, i) => String(i % 10)).join(""));
	}, 30_000);
});
