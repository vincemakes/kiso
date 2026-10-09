/**
 * 0.49.0 C1 through the real TUI: a child that names no model runs on the
 * conversation's profile — the one the person switched to, not the
 * config's default — and still does after /reload, which clears the
 * display's profile mark (index.ts: "the reload snapshot carries no
 * profile name"). The binding is read from the session itself.
 *
 * The parent runs on real profiles against a loopback openai-compat
 * stub in its own process (the pty driver blocks this one): a person's
 * line is answered with a delegate call, a tool result with a closing
 * line. The child is a scripted process (KISO_SUBAGENT_BIN) that records
 * the --model it was launched with and writes its result record.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const CHILD = `
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
appendFileSync(process.env.C1_LAUNCHES, JSON.stringify({ model: at("--model") }) + "\\n");
const result = at("--result-file");
writeFileSync(result, "looked\\n\\nUNRESOLVED\\nnone\\n");
writeFileSync(join(dirname(result), "result.json"), JSON.stringify({ outcome: "completed", endedBy: "completed", requests: 1, toolCalls: 0, model: "m", profile: at("--model") }));
`;

/** The loopback model: a person's line → a delegate call; a tool result →
 *  FIRST-DONE, then SECOND-DONE; it logs the model each request named. */
const STUB = `
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [portFile, log] = process.argv.slice(2);
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const parsed = JSON.parse(body);
		appendFileSync(log, JSON.stringify({ model: parsed.model }) + "\\n");
		const msgs = parsed.messages ?? [];
		const last = msgs[msgs.length - 1] ?? {};
		const results = msgs.filter((m) => m.role === "tool").length;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish) => res.write("data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish !== null ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) }) + "\\n\\n");
		if (last.role === "user" && results < 2) {
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + results, type: "function", function: { name: "delegate", arguments: JSON.stringify({ tasks: [{ role: "explorer", task: "look" }] }) } }] }, null);
			chunk({}, "tool_calls");
		} else {
			chunk({ role: "assistant", content: last.role === "tool" ? (results === 1 ? "FIRST-DONE" : "SECOND-DONE") : "spare" }, null);
			chunk({}, "stop");
		}
		res.write("data: [DONE]\\n\\n");
		res.end();
	});
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
`;

describe("0.49.0 C1 — the conversation's profile survives /reload for a delegated child", () => {
	it("switched to beta, a child runs on beta; after /reload, the next child still does — never the config's default alpha", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-c1-reload-"));
		writeFileSync(join(dir, "child.mjs"), CHILD, "utf8");
		writeFileSync(join(dir, "stub.mjs"), STUB, "utf8");
		const launches = join(dir, "launches.jsonl");
		const requests = join(dir, "requests.jsonl");
		const portFile = join(dir, "port");
		const stub = spawn(process.execPath, [join(dir, "stub.mjs"), portFile, requests], { stdio: "ignore" });
		try {
			for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
			const base = `http://127.0.0.1:${readFileSync(portFile, "utf8")}/v1`;
			const { env, dirs } = isolatedEnv({ KISO_SUBAGENT_BIN: join(dir, "child.mjs"), C1_LAUNCHES: launches, C1_KEY: "k-test" });
			writeFileSync(
				join(dirs.home, "config.json"),
				`${JSON.stringify({
					model: "alpha",
					models: {
						alpha: { kind: "openai-compat", model: "model-alpha", apiKeyEnv: "C1_KEY", baseUrl: base },
						beta: { kind: "openai-compat", model: "model-beta", apiKeyEnv: "C1_KEY", baseUrl: base },
					},
				})}\n`,
				"utf8",
			);
			const raw = ptyRun(["--mode", "bypass", "c1-reload"], env as NodeJS.ProcessEnv, {
				feeds: [
					["/mode to switch", "/model beta\r"],
					["model-beta", "map the code\r"],
					["FIRST-DONE", "/reload\r"],
					["reloaded ", "map it again\r"],
					["SECOND-DONE", "exit\r"],
				],
				timeout: 90,
			});
			const out = strip(raw);
			expect(out, "the reload ran").toContain("reloaded ");
			expect(out, "the second turn finished").toContain("SECOND-DONE");
			const asked = readFileSync(requests, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { model: string }).model);
			expect(new Set(asked), "the parent itself ran on beta throughout").toEqual(new Set(["model-beta"]));
			const models = readFileSync(launches, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { model: string | null }).model);
			expect(models, "both children ran on the conversation's profile").toEqual(["beta", "beta"]);
		} finally {
			stub.kill("SIGKILL");
		}
	}, 300_000);
});
