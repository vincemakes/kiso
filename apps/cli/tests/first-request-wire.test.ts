import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { defaultCompositionParts } from "../../../scripts/request-surface.mjs";

/**
 * Plan A (rev 2), gate 2 — THE WIRE FIXTURE.
 *
 * The rent ledger is a PREDICTION, and for three releases it predicted a
 * request the product did not send: no task-shaped shell, no task_stop,
 * no wait, and none of the generated tool table (findings RG-F1, RG-F2,
 * RG-F3 — 7,346 predicted chars against 11,740 on the wire). The R7 gate
 * stayed green throughout, because prediction and record were wrong in
 * the same way.
 *
 * This gate reads the WIRE: the built CLI, `kiso -p hello`, a bare home,
 * an openai-compat profile aimed at a loopback sink. The first request
 * body is compared byte for byte with the committed fixture, and its
 * parts are tied back to the ledger's composition: the system prompt is
 * the base and the generated table, and the tools are the predicted
 * tools, spec for spec. A changed description, a new top-level field, a
 * different split of the prompt — each fails here with a diff.
 *
 * Regenerate deliberately: KISO_UPDATE_WIRE_FIXTURE=1 rewrites the fixture,
 * and the diff is the review artefact. No network: 127.0.0.1 only.
 */
const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "cli", "dist", "index.js");
const FIXTURE = fileURLToPath(new URL("./fixtures/first-request.openai-compat.json", import.meta.url));

async function firstRequest(): Promise<Record<string, unknown>> {
	const bodies: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => {
			bodies.push(b);
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "the wire fixture's sink" } }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	try {
		const { dirs, env } = isolatedEnv({ WIRE_FIXTURE_KEY: "DUMMY_WIRE_FIXTURE" });
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({
				model: "wire",
				models: { wire: { kind: "openai-compat", model: "fixture-model", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "WIRE_FIXTURE_KEY", contextWindow: 128000 } },
			}),
		);
		const child = spawn(process.execPath, [CLI, "-p", "hello"], { env, cwd: dirs.home, stdio: "ignore" });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		await new Promise<void>((r) => child.on("exit", () => r()));
		clearTimeout(timer);
		await new Promise((r) => setTimeout(r, 100));
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
	expect(bodies.length, "the CLI sent no request to the sink").toBeGreaterThan(0);
	return JSON.parse(bodies[0]!) as Record<string, unknown>;
}

type WireTool = { type: string; function: { name: string; description: string; parameters: unknown } };

describe("Plan A gate 2: the first request on the wire", () => {
	it("is byte-identical to the committed fixture, and deterministic", async () => {
		const a = await firstRequest();
		const b = await firstRequest();
		expect(JSON.stringify(b), "two captures of the same composition differ").toBe(JSON.stringify(a));
		const text = `${JSON.stringify(a, null, "\t")}\n`;
		if (process.env.KISO_UPDATE_WIRE_FIXTURE === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, text);
		expect(text).toBe(readFileSync(FIXTURE, "utf8"));
	}, 60_000);

	it("is the ledger's composition: the base, the generated table, the predicted tools", async () => {
		const body = await firstRequest();
		const { composeToolTable } = await import("../../../packages/runtime/dist/compose.js");
		const { ToolRegistry } = await import("@vincemakes/kiso-core");
		const parts = await defaultCompositionParts({ home: isolatedEnv().dirs.home });
		const registry = new ToolRegistry();
		for (const t of parts.tools) registry.register(t);
		for (const ext of parts.extensions) {
			for (const t of (ext as { tools?: never[] }).tools ?? []) registry.register(t);
		}
		const messages = body.messages as { role: string; content: string }[];
		const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
		expect(system).toBe(`${parts.base}\n\n${composeToolTable(registry, parts.toolRules)}`);
		const wire = (body.tools as WireTool[]).map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));
		expect(wire).toEqual(registry.toSpecs().map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema })));
	}, 60_000);
});
