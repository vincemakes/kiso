/**
 * ADR-0058 Amendment 7 through the CLI's real entry — the 0460-B2 shape.
 * The model starts a service with background + readyWhen, probes it, stops
 * it, and answers. Every transition was told in a tool result: the start's
 * result says ready (the call waited for it), and task_stop's says
 * stopped (the call waited for the end). So no task notice reaches the
 * model, and nothing follows the final answer. The 0.46.0 rc this replaces
 * sent a ready notice and a stopped notice; the stopped one landed after
 * the final answer and bought a fifth request.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { type: string; reason?: string; via?: { kind: string } };
const eventsOf = (home: string): Ev[] =>
	existsSync(join(home, "sessions", "sv.jsonl"))
		? readFileSync(join(home, "sessions", "sv.jsonl"), "utf8")
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => (JSON.parse(l) as { event: Ev }).event)
		: [];

const SERVER = `node -e "console.log('listening'); setInterval(() => {}, 1000)"`;

function script(home: string): string {
	const path = join(home, "faux.json");
	const call = (id: string, name: string, input: object) => ({ events: [{ type: "tool_call_end", callId: id, name, input }, { type: "stop", reason: "tool_use" }] });
	writeFileSync(
		path,
		JSON.stringify([
			call("s1", "shell", { command: SERVER, background: true, readyWhen: "listening" }),
			// a real model takes seconds per request: a notice the runtime
			// sends lands INSIDE the run (a poll is 500 ms, a window 1 s),
			// which is where the 0.46.0 rc's two notices landed
			{ events: [{ type: "delay", ms: 2_500 }, ...call("p1", "shell", { command: "echo probe" }).events] },
			call("x1", "task_stop", { id: "t1" }),
			{ events: [{ type: "delay", ms: 2_500 }, { type: "text_delta", text: "fixed and stopped" }, { type: "stop", reason: "end_turn" }] },
			// a fifth request would be the defect: it is scripted so the
			// run does not fail on an exhausted script, and then counted
			{ events: [{ type: "text_delta", text: "t1 confirmed stopped" }, { type: "stop", reason: "end_turn" }] },
		]),
	);
	return path;
}

describe("ADR-0058 Amendment 7 — a service started, probed and stopped: no notice, nothing after the final answer", () => {
	it("four requests, no task notice; the person's transcript ends at the answer", async () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
		const cwd = mkdtempSync(join(tmpdir(), "kiso-claims-ws-"));
		const child = spawn("node", [CLI, "chat", "sv"], { env: { ...env, KISO_FAUX_SCRIPT: script(dirs.home) }, cwd, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d: Buffer) => (out += d.toString()));
		child.stderr.on("data", (d: Buffer) => (out += d.toString()));
		const closed = new Promise<number | null>((r) => child.on("close", r));
		child.stdin.write("start the server, probe it, stop it\n");
		const deadline = Date.now() + 30_000;
		while (!eventsOf(dirs.home).some((e) => e.type === "stop" && e.reason === "end_turn")) {
			if (Date.now() > deadline) throw new Error(`no final answer; output:\n${out}`);
			await sleep(100);
		}
		// a late notice needs one poll (500 ms) and one window (1 s) to land
		await sleep(3_000);
		child.stdin.end();
		expect(await closed).toBe(0);
		const events = eventsOf(dirs.home);
		expect(events.filter((e) => e.type === "user_input" && e.via?.kind === "tasks")).toEqual([]);
		expect(events.filter((e) => e.type === "stop")).toHaveLength(4);
		expect(out).not.toContain("t1 confirmed stopped");
	}, 60_000);
});
