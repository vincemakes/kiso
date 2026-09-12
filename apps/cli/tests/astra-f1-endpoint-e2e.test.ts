import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

/**
 * Astra F1 (P0) — THE END-TO-END CAPTURE, IN THE REVIEWER'S OWN SHAPE.
 *
 * The unit tests say the resolver resolves and the option builder builds.
 * Neither of them runs the product. Astra's reproduction did: a loopback
 * server, a stored vendor key, a profile that names no baseUrl, and the
 * SDK's own environment variable pointing at the loopback. On 0.34.0 and
 * 0.35.0 the key ARRIVED at the loopback.
 *
 * The assertion is the one that matters and it is about ABSENCE: the
 * loopback must receive NOTHING. A test that only checked the CLI's exit
 * code would pass on the defect — the CLI exits non-zero either way, since
 * the request fails whichever host it reaches.
 *
 * No network: 127.0.0.1 on an ephemeral port. Nothing here can reach a
 * vendor, and nothing is meant to — a request that leaves for the real
 * api.anthropic.com with a dummy key is refused there and never seen here,
 * which is exactly the pass condition.
 */
const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "cli", "dist", "index.js");

interface Capture {
	readonly host: string | undefined;
	readonly key: string | undefined;
}

async function legReachesLoopback(kind: "anthropic" | "openai-compat"): Promise<readonly Capture[]> {
	const captures: Capture[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		captures.push({ host: req.headers.host, key: (req.headers["x-api-key"] as string | undefined) ?? req.headers.authorization });
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { type: "authentication_error", message: "synthetic test error" } }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const url = `http://127.0.0.1:${port}`;
	try {
		const { dirs, env } = isolatedEnv({
			// The SDK's own variable, aimed at the loopback. THIS is the
			// attack: with no explicit baseUrl the SDK used to read it.
			...(kind === "anthropic" ? { ANTHROPIC_BASE_URL: url } : { OPENAI_BASE_URL: url }),
			REVIEW_GATEWAY_KEY: "DUMMY_GATEWAY",
		});
		// The vendor's own stored credential — what must never leave.
		const provider = kind === "anthropic" ? "anthropic" : "openai";
		writeFileSync(
			join(dirs.home, "auth.json"),
			JSON.stringify({ version: 1, credentials: { [provider]: { type: "api-key", key: `DUMMY_STORED_${provider}`, savedAt: Date.now() } } }),
			{ mode: 0o600 },
		);
		// A profile that names NO baseUrl — the common configuration, and the
		// one 0.32.2's R1 fix did not bind.
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({
				model: "review",
				models: { review: { kind, model: kind === "anthropic" ? "claude-sonnet-5" : "gpt-4o", apiKeyEnv: "REVIEW_GATEWAY_KEY" } },
			}),
		);
		const child = spawn(process.execPath, [CLI, "--model", "review", "-p", "hello"], { env, cwd: dirs.home, stdio: "ignore" });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		await new Promise<void>((r) => child.on("exit", () => r()));
		clearTimeout(timer);
		// The socket may still be draining when the child exits.
		await new Promise((r) => setTimeout(r, 250));
		return captures;
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
}

describe("F1 (P0) e2e: a stored vendor key never leaves for the environment's endpoint", () => {
	for (const kind of ["anthropic", "openai-compat"] as const) {
		it(`${kind}: no baseUrl + a hostile SDK env var — the loopback receives NOTHING`, async () => {
			const captures = await legReachesLoopback(kind);
			// Named so a failure prints what arrived, not just a count.
			expect(captures.map((c) => `${c.host} ${String(c.key).slice(0, 24)}`)).toEqual([]);
		}, 60_000);
	}
});
