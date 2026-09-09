/**
 * LT-1 — a model stream that goes silent ends, on screen and in the log.
 *
 * REAL kiso chat under a pty against a local OpenAI-compatible stub that
 * sends ONE text delta and then never writes again — the hung socket. With
 * KISO_STREAM_IDLE_MS=1500 the watchdog trips 1.5 s after that delta; the
 * kernel voids the draft (the abandoned notice), retries with backoff, and
 * when the budget is spent the run ends in the error terminal OR-5 prints.
 * The session survives: the next turn is a normal one.
 *
 * The stub runs OUT OF PROCESS (ptyRun is spawnSync — see registry-stub).
 * The stall is the stub's whole behaviour; nothing here waits on a wall.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";
import { VtScreen } from "./helpers/vt-screen.js";

const STUB = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const portFile = process.env.STUB_PORT_FILE;
let hits = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    hits += 1;
    try { writeFileSync(process.env.STUB_HIT_FILE, String(hits)); } catch {}
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // one delta, then silence: the socket stays open and nothing else is ever written
    res.write('data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Harbors are"},"finish_reason":null}]}\\n\\n');
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
`;

let child: ChildProcess | null = null;
afterEach(() => {
	child?.kill("SIGKILL");
	child = null;
});

function startStall(): { url: string; hits: () => number } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-stall-stub-"));
	const portFile = join(dir, "port");
	const hitFile = join(dir, "hits");
	const script = join(dir, "stub.mjs");
	writeFileSync(script, STUB, "utf8");
	child = spawn("node", [script], { env: { ...process.env, STUB_PORT_FILE: portFile, STUB_HIT_FILE: hitFile }, stdio: "ignore" });
	const deadline = Date.now() + 10_000;
	while (!existsSync(portFile)) {
		if (Date.now() > deadline) throw new Error("the stall stub never reported its port");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	const port = readFileSync(portFile, "utf8").trim();
	return { url: `http://127.0.0.1:${port}/v1`, hits: () => (existsSync(hitFile) ? Number(readFileSync(hitFile, "utf8")) : 0) };
}

const ROWS = 30;
const COLS = 100;
const screen = (raw: string): string[] => {
	const t = new VtScreen(ROWS, COLS);
	t.write(Buffer.from(raw, "utf8"));
	return t.visible().map((r) => r.replace(/\s+$/, ""));
};

describe("LT-1 — the stream watchdog on a real PTY", () => {
	it("a silent stream is voided, retried, and ended as a network error the screen names; the session survives", () => {
		const stub = startStall();
		const { env, dirs } = isolatedEnv({
			KISO_STREAM_IDLE_MS: "1500",
			STALL_KEY: "sk-stall", // a non-top-level env var: the session is a real profile, not faux
		});
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify({ models: { stall: { kind: "openai-compat", model: "stall-model", baseUrl: stub.url, apiKeyEnv: "STALL_KEY" } }, model: "stall" })}\n`);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-stall-w-"));
		const raw = ptyRun(["--mode", "bypass", "lt1-stall"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "Say something.\r"],
				// the error line is the last thing the turn says; exit on it
				["run failed", "exit\r"],
			],
			timeout: 60,
			rows: ROWS,
			cols: COLS,
		});
		const rows = screen(raw);
		const text = rows.join("\n");
		// the draft that arrived before the silence was voided visibly (F4), not welded to a retry
		expect(text, "the abandoned-draft notice never showed").toContain("stream interrupted");
		// the terminal names the stall, in the watchdog's own words
		// `run failed — network (retryable): stream stalled: no event for 2s (2s into the request)`
		expect(text, "the error line never named the stall").toMatch(/run failed — network.*stream stalled: no event for 2s/);
		// three attempts (the first plus the default two retries), each voided visibly
		expect(rows.filter((r) => r.includes("stream interrupted")).length, "one abandoned notice per attempt").toBe(3);
		// the budget was spent honestly: the first attempt plus the retries all reached the stub
		expect(stub.hits(), "the kernel did not retry the stalled request").toBeGreaterThanOrEqual(3);

		// the durable log carries the voids with the reason, and an error terminal
		const log = readFileSync(join(dirs.home, "sessions", "lt1-stall.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: { type: string; reason?: string; outcome?: { kind: string; error?: { code: string; message: string } } } });
		// one void per attempt, in the kernel's own words (the marker records THAT
		// the draft was abandoned; WHY is the terminal's, below)
		const voids = log.filter((e) => e.event.type === "model_output_abandoned");
		expect(voids.length, "no void marker in the log").toBe(3);
		const terminal = log.find((e) => e.event.type === "terminal");
		expect(terminal?.event.outcome?.kind).toBe("error");
		expect(terminal?.event.outcome?.error?.code).toBe("network");
		expect(terminal?.event.outcome?.error?.message ?? "", "the terminal does not name the stall").toContain("stream stalled: no event for 2s");
	}, 120_000);
});
