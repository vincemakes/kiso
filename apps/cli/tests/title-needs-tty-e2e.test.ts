import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TITLE_PROMPT } from "@vincemakes/kiso-runtime/internal";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

/**
 * The session title is the interactive terminal's, never a piped chat's. A
 * chat whose stdin is a pipe is a script or a bench leg: one more request per
 * session there would be paid by every leg, and the plan says the title never
 * runs headless. The built CLI, a loopback that refuses every request, the
 * title switch left ON: no body carries the title prompt.
 */
const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "cli", "dist", "index.js");

describe("the session title needs a TTY", () => {
	it("a piped chat's first message sends no title request", async () => {
		const bodies: string[] = [];
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (d: string) => {
				body += d;
			});
			req.on("end", () => {
				bodies.push(body);
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "synthetic test refusal" } }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		try {
			const { dirs, env } = isolatedEnv({ GATEWAY_TEST_KEY: "k-test" });
			delete env.KISO_AUTO_TITLE;
			writeFileSync(
				join(dirs.home, "config.json"),
				JSON.stringify({ model: "gw", models: { gw: { kind: "openai-compat", model: "some-model", apiKeyEnv: "GATEWAY_TEST_KEY", baseUrl: `http://127.0.0.1:${port}/v1` } } }),
			);
			const child = spawn(process.execPath, [CLI, "--model", "gw", "titled-or-not"], { env, cwd: dirs.home, stdio: ["pipe", "ignore", "ignore"] });
			child.stdin.end("plan a trip to the coast for the weekend\n");
			const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
			await new Promise<void>((r) => child.on("exit", () => r()));
			clearTimeout(timer);
			await new Promise((r) => setTimeout(r, 250));
			expect(bodies.length, "the run's own request reached the loopback").toBeGreaterThan(0);
			expect(bodies.filter((b) => b.includes(TITLE_PROMPT)), "no title request").toEqual([]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 60_000);
});
