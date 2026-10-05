/**
 * ADR-0058 Amendment 7 — a transition a tool result reports is not noticed
 * again. `awaitSettled` waits for a task's end (or its ready line) on behalf
 * of a tool call; what it observes is CLAIMED for that call's own execution
 * — `result_claimed` durable first, then the transition is marked seen — so
 * the watcher never announces it. Timeout, abort, a failed append, no
 * execution id, an agent task, and every stop that is not the model's own
 * call claim nothing: those transitions are announced as before.
 */
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord, readRecords } from "../src/tasks/journal.js";
import { TaskManager, type TaskBackend, type TaskTransition } from "../src/tasks/manager.js";

function fakeBackend(): TaskBackend {
	let pid = 100;
	return {
		async spawn({ dir }) {
			pid += 1;
			appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid, startedAt: `start-${pid}` });
			appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
		},
		identify: (p, startedAt) => (startedAt === `start-${p}` ? "verified" : "gone"),
		signalStop: () => {},
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const journal = (m: TaskManager, id: string) => join(m.root, id, "journal.jsonl");
const end = (m: TaskManager, id: string, exitCode: number | null = 0, signal: string | null = null) =>
	appendRecord(journal(m, id), { type: "terminal", ts: Date.now(), exitCode, signal });
const claims = (m: TaskManager, id: string) => readRecords(journal(m, id)).filter((r) => (r.type as string) === "result_claimed");

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "kiso-claims-"));
	const heard: { id: string; transition: TaskTransition }[] = [];
	// a fast poll: every wait below spans many polls, so a waited id the
	// watcher did NOT skip would be announced
	const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend(), pollMs: 10, onTransition: (t, transition) => heard.push({ id: t.id, transition }) });
	return { manager, heard };
}

describe("awaitSettled — what the wait sees is claimed for the CALLING execution, and never announced", () => {
	it("a model stop ended within the wait: settled, claimed for the stopping call (not the task's starter), no transition", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "node server.js", cwd: "/", executionId: "ex-start" });
		expect(manager.stop(t.id, "model")).toBe(true);
		setTimeout(() => end(manager, t.id, null, "SIGTERM"), 30);
		const r = await manager.awaitSettled(t.id, "end", 2_000, { executionId: "ex-stop" });
		expect(r).toMatchObject({ settled: true, claimed: true });
		expect(r.info.state).toMatchObject({ kind: "ended", signal: "SIGTERM", stopped: true });
		expect(claims(manager, t.id)).toEqual([expect.objectContaining({ type: "result_claimed", transition: "stopped", executionId: "ex-stop" })]);
		expect(manager.get(t.id)!.claims).toEqual([{ transition: "stopped", executionId: "ex-stop" }]);
		await sleep(80);
		expect(heard).toEqual([]);
		manager.close();
	});

	it("the ready line within the wait: claimed ready; the task keeps running and no ready transition is announced", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "node server.js", cwd: "/", executionId: "ex-1", readyWhen: "listening", profile: "service" });
		setTimeout(() => appendRecord(journal(manager, t.id), { type: "ready", ts: Date.now(), match: "listening" }), 30);
		const r = await manager.awaitSettled(t.id, "ready", 2_000, { executionId: "ex-1" });
		expect(r).toMatchObject({ settled: true, claimed: true });
		expect(r.info.state).toEqual({ kind: "running", ready: true });
		expect(claims(manager, t.id)).toEqual([expect.objectContaining({ transition: "ready", executionId: "ex-1" })]);
		await sleep(80);
		expect(heard).toEqual([]);
		// its later end is NOT claimed: it is announced as usual
		end(manager, t.id, 1);
		await sleep(80);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});

	it("an end before the ready line settles the ready wait too, and is claimed under its own name", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "node server.js", cwd: "/", executionId: "ex-1", readyWhen: "listening", profile: "service" });
		setTimeout(() => end(manager, t.id, 3), 30);
		const r = await manager.awaitSettled(t.id, "ready", 2_000, { executionId: "ex-1" });
		expect(r).toMatchObject({ settled: true, claimed: true });
		expect(claims(manager, t.id)).toEqual([expect.objectContaining({ transition: "failed", executionId: "ex-1" })]);
		await sleep(80);
		expect(heard).toEqual([]);
		manager.close();
	});

	it("a runner that vanished without an end settles the end wait as unknown, claimed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-claims-"));
		let alive = true;
		const backend: TaskBackend = { ...fakeBackend(), identify: () => (alive ? "verified" : "gone") };
		const heard: TaskTransition[] = [];
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend, pollMs: 10, identifyEveryMs: 0, onTransition: (_t, tr) => heard.push(tr) });
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		setTimeout(() => (alive = false), 30);
		const r = await manager.awaitSettled(t.id, "end", 2_000, { executionId: "ex-stop" });
		expect(r).toMatchObject({ settled: true, claimed: true });
		expect(r.info.state.kind).toBe("unknown");
		expect(claims(manager, t.id)).toEqual([expect.objectContaining({ transition: "unknown", executionId: "ex-stop" })]);
		await sleep(80);
		expect(heard).toEqual([]);
		manager.close();
	});
});

describe("awaitSettled — nothing claimed: the transition is announced as before", () => {
	it("a timeout claims nothing, and the end that comes later is announced", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		const r = await manager.awaitSettled(t.id, "end", 120, { executionId: "ex-stop" });
		expect(r).toMatchObject({ settled: false, claimed: false });
		end(manager, t.id);
		await sleep(80);
		expect(claims(manager, t.id)).toEqual([]);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});

	it("an abort ends the wait at once and claims nothing", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 40);
		const t0 = Date.now();
		const r = await manager.awaitSettled(t.id, "end", 5_000, { executionId: "ex-stop", signal: ac.signal });
		expect(Date.now() - t0).toBeLessThan(1_000);
		expect(r).toMatchObject({ settled: false, claimed: false });
		end(manager, t.id);
		await sleep(80);
		expect(claims(manager, t.id)).toEqual([]);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});

	it("no execution id: the wait still settles, but nothing is claimed and the end is announced", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		setTimeout(() => end(manager, t.id), 30);
		const r = await manager.awaitSettled(t.id, "end", 2_000, {});
		expect(r).toMatchObject({ settled: true, claimed: false });
		await sleep(80);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});

	it("an agent task is never claimed: its end belongs to its group", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "explorer", cwd: "/", executionId: "ex-d", agent: { role: "explorer", session: "sub-1" } });
		manager.stop(t.id, "model");
		setTimeout(() => end(manager, t.id, null, "SIGTERM"), 30);
		const r = await manager.awaitSettled(t.id, "end", 2_000, { executionId: "ex-stop" });
		expect(r).toMatchObject({ settled: true, claimed: false });
		await sleep(80);
		expect(claims(manager, t.id)).toEqual([]);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});

	it("stopAll — an exit's stop — never claims", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		setTimeout(() => end(manager, t.id, null, "SIGTERM"), 30);
		expect(await manager.stopAll("exit", 2_000)).toEqual([]);
		await sleep(80);
		expect(claims(manager, t.id)).toEqual([]);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});

	// the frozen order: the claim is durable BEFORE the transition counts as
	// seen — an append that fails leaves it unseen, and it is announced (a
	// duplicate is the lesser evil next to a lost transition)
	const writable = process.platform !== "win32" && process.getuid?.() !== 0;
	it.skipIf(!writable)("a claim that cannot be written claims nothing, and the transition is still announced", async () => {
		const { manager, heard } = setup();
		const t = await manager.start({ command: "x", cwd: "/", executionId: "ex-1" });
		setTimeout(() => {
			end(manager, t.id);
			chmodSync(journal(manager, t.id), 0o444);
		}, 30);
		const r = await manager.awaitSettled(t.id, "end", 2_000, { executionId: "ex-stop" });
		expect(r).toMatchObject({ settled: true, claimed: false });
		await sleep(80);
		chmodSync(journal(manager, t.id), 0o644);
		expect(claims(manager, t.id)).toEqual([]);
		expect(heard).toEqual([{ id: t.id, transition: "ended" }]);
		manager.close();
	});
});

describe("adopt — a promotion whose result says ready claims ready for the shell call", () => {
	it("adopt({ ready: true }) writes result_claimed ready for its execution; a plain promotion claims nothing", () => {
		const { manager } = setup();
		const runner = { pid: process.pid, startedAt: "" };
		const ready = manager.adopt({ command: "npm run dev", cwd: "/", executionId: "ex-p", readyWhen: "Local:", runner, ready: true, stop: () => {} });
		expect(claims(manager, ready.id)).toEqual([expect.objectContaining({ transition: "ready", executionId: "ex-p" })]);
		const waited = manager.adopt({ command: "npm test", cwd: "/", executionId: "ex-w", runner, stop: () => {} });
		expect(claims(manager, waited.id)).toEqual([]);
		manager.close();
	});
});
