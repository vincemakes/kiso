/**
 * ③ — the MCP bridge unit tests (against the BUILT bundle: dist/kiso-mcp.mjs
 * is exactly the artifact the E1 loader imports).
 *
 * ① schema intact  ② echo roundtrip  ③ fail → isError  ④ credential strip +
 * config env overlay  ⑤ broken config throws  ⑥ absent config → status only
 * ⑦ unreachable server = soft failure, others usable  ⑧ slow + abort →
 * timely isError.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import createMcpExtension from "../dist/kiso-mcp.mjs";
import type { KisoExtension, Tool, ToolContext } from "@vincemakes/kiso-core";

const FAKE_SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "fake-server.mjs");

const ctx: ToolContext = { signal: new AbortController().signal };

function fakeConfig(): Record<string, unknown> {
	return { command: "node", args: [FAKE_SERVER], env: { CUSTOM_VAR: "custom-value" } };
}

/** Write a config file, point KISO_MCP_CONFIG at it, load the factory.
 *  `config === null` = the file is ABSENT (the no-servers case).
 *  0.1.26 (lazy connection): the factory returns IMMEDIATELY — the server tools land
 *  after the background connect. extWith awaits the settle, so the tests
 *  exercise the post-connect state; the pre-connect wait is the e2e's
 *  "the first-call waits-for-readiness" scenario. */
async function settled(ext: KisoExtension, server: string): Promise<void> {
	const statusTool = ext.tools?.find((t) => t.name === "mcp__status");
	const end = Date.now() + 8000;
	while (Date.now() < end) {
		if (ext.tools?.some((t) => t.name.startsWith(`mcp__${server}__`))) return;
		// A failed connect settles too (disconnects are honest): the status flips to error.
		if (statusTool !== undefined) {
			const r = await statusTool.execute({}, ctx);
			const text = String(r.content);
			if (text.includes(`${server}: connected`) || text.includes(`${server}: error`)) return;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`mcp server ${server} never settled; tools: ${ext.tools?.map((t) => t.name).join(", ")}`);
}

async function extWith(config: Record<string, unknown> | null): Promise<KisoExtension> {
	const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-"));
	const path = join(dir, "mcp.json");
	if (config !== null) writeFileSync(path, JSON.stringify(config), "utf8");
	process.env.KISO_MCP_CONFIG = path;
	// KISO_HOME isolated — the tool cache must never touch the real home.
	const prevHome = process.env.KISO_HOME;
	process.env.KISO_HOME = join(dir, "home");
	try {
		const ext = await createMcpExtension();
		if (config !== null && (config.mcpServers as Record<string, unknown> | undefined) !== undefined) {
			for (const name of Object.keys((config as { mcpServers: Record<string, unknown> }).mcpServers)) {
				await settled(ext, name);
			}
		}
		return ext;
	} finally {
		delete process.env.KISO_MCP_CONFIG;
		if (prevHome === undefined) delete process.env.KISO_HOME;
		else process.env.KISO_HOME = prevHome;
	}
}

const tool = (ext: KisoExtension, name: string): Tool => {
	const t = ext.tools?.find((x) => x.name === name);
	if (t === undefined) throw new Error(`no tool ${name} in ${ext.tools?.map((x) => x.name).join(", ")}`);
	return t;
};

describe("③ MCP bridge: tools", () => {
	it("⑪ KISO_HOME is the ONE root — the config defaults under it (finding #11)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-"));
		const home = join(dir, "home"); // KISO_HOME IS the .kiso dir itself
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: fakeConfig() } }), "utf8");
		process.env.KISO_HOME = home;
		delete process.env.KISO_MCP_CONFIG;
		try {
			const ext = await createMcpExtension();
			// 0.1.26 (lazy connection): the factory returns immediately — the tools
			// land after the background connect; the wait IS the test.
			await settled(ext, "fake");
			expect(ext.tools?.some((t) => t.name === "mcp__fake__echo")).toBe(true);
		} finally {
			delete process.env.KISO_HOME;
		}
	}, 30_000);

	it("① connects the fake server — mcp__fake__echo exists with its schema INTACT", async () => {
		const ext = await extWith({ mcpServers: { fake: fakeConfig() } });
		expect(ext.name).toBe("mcp");
		const echo = tool(ext, "mcp__fake__echo");
		expect(echo.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
		expect(echo.description).toBe("Echo the given text");
	}, 30_000);

	it("② echo roundtrips through the real server", async () => {
		const ext = await extWith({ mcpServers: { fake: fakeConfig() } });
		const r = await tool(ext, "mcp__fake__echo").execute({ text: "hello mcp" }, ctx);
		expect(r).toEqual({ content: "hello mcp", isError: false });
	}, 30_000);

	it("③ an MCP isError result maps to kiso isError: true", async () => {
		const ext = await extWith({ mcpServers: { fake: fakeConfig() } });
		const r = await tool(ext, "mcp__fake__fail").execute({}, ctx);
		expect(r.isError).toBe(true);
		expect(String(r.content)).toContain("intentional failure");
	}, 30_000);
});

describe("③ MCP bridge: environment", () => {
	it("④ provider credentials are stripped from the stdio child; the config env arrives", async () => {
		// Set the credentials BEFORE the factory loads — the strip list is
		// applied to process.env at that moment.
		process.env.ANTHROPIC_API_KEY = "sk-secret";
		process.env.OPENAI_API_KEY = "sk-secret";
		process.env.ANTHROPIC_BASE_URL = "https://secret";
		process.env.GLM_AUTH_TOKEN = "tok-secret";
		try {
			const ext = await extWith({ mcpServers: { fake: fakeConfig() } });
			const probe = tool(ext, "mcp__fake__env_probe");
			const run = async (name: string): Promise<string> => String((await probe.execute({ name }, ctx)).content);
			expect(await run("ANTHROPIC_API_KEY")).toBe(""); // stripped
			expect(await run("OPENAI_API_KEY")).toBe(""); // stripped
			expect(await run("ANTHROPIC_BASE_URL")).toBe(""); // exact-list stripped
			expect(await run("GLM_AUTH_TOKEN")).toBe(""); // pattern-stripped
			expect(await run("CUSTOM_VAR")).toBe("custom-value"); // config env overlaid
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.OPENAI_API_KEY;
			delete process.env.ANTHROPIC_BASE_URL;
			delete process.env.GLM_AUTH_TOKEN;
		}
	}, 30_000);
});

describe("③ MCP bridge: config and failure modes", () => {
	it("⑤ a present but broken config throws LOUDLY", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-"));
		const path = join(dir, "mcp.json");
		writeFileSync(path, "{not json", "utf8");
		process.env.KISO_MCP_CONFIG = path;
		try {
			// 0.1.26: the factory is SYNC — the broken config throws LOUDLY at the call, not a rejection.
			expect(() => createMcpExtension()).toThrow(/cannot parse/);
		} finally {
			delete process.env.KISO_MCP_CONFIG;
		}
	}, 30_000);

	it("⑤b a structurally invalid server entry throws LOUDLY", async () => {
		await expect(extWith({ mcpServers: { lonely: { args: [] } } })).rejects.toThrow(/needs a command/);
	}, 30_000);

	it("⑥ an absent config is no servers — only mcp__status, never an error", async () => {
		const ext = await extWith(null);
		expect(ext.name).toBe("mcp");
		expect(ext.tools?.map((t) => t.name)).toEqual(["mcp__status"]);
		const r = await ext.tools![0]!.execute({}, ctx);
		expect(String(r.content)).toContain("no MCP servers configured");
	}, 30_000);

	it("⑦ an unreachable server is a SOFT failure — its error lands in mcp__status, the other server still works", async () => {
		const ext = await extWith({
			mcpServers: {
				broken: { command: "kiso-no-such-command-xyz", args: [] },
				fake: fakeConfig(),
			},
		});
		const status = tool(ext, "mcp__status");
		const r = await status.execute({}, ctx);
		expect(String(r.content)).toContain("broken: error");
		expect(String(r.content)).toContain("fake: connected");
		const echo = tool(ext, "mcp__fake__echo");
		expect(String((await echo.execute({ text: "still alive" }, ctx)).content)).toBe("still alive");
	}, 30_000);

	it("⑧ slow + immediate abort returns a timely isError — it never waits the 5s", async () => {
		const ext = await extWith({ mcpServers: { fake: fakeConfig() } });
		const slow = tool(ext, "mcp__fake__slow");
		const ac = new AbortController();
		const started = Date.now();
		const pending = slow.execute({}, { signal: ac.signal });
		ac.abort();
		const r = await pending;
		expect(r.isError).toBe(true);
		expect(Date.now() - started).toBeLessThan(4000); // abort cut it short
	}, 30_000);

describe("0.1.26 (lazy connection): the tool cache — pre-ready calls wait, disconnects are honest", () => {
	it("a CACHED tool's call waits for the background connect; a broken server's cached call fails with the connect error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mcp-cache-"));
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		// Prime the cache with the RAW server tool names (as a previous
		// successful connect wrote them).
		writeFileSync(
			join(home, "mcp-tools.json"),
			JSON.stringify({
				fake: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
				broken: [{ name: "x", description: "X", inputSchema: { type: "object", properties: {} } }],
			}),
			"utf8",
		);
		const mcpConfig = join(dir, "mcp.json");
		writeFileSync(
			mcpConfig,
			JSON.stringify({
				mcpServers: {
					fake: fakeConfig(),
					broken: { command: "node", args: ["/nonexistent-kiso-mcp-server.mjs"] },
				},
			}),
			"utf8",
		);
		process.env.KISO_HOME = home;
		process.env.KISO_MCP_CONFIG = mcpConfig;
		try {
			const ext = await createMcpExtension();
			// The factory returned INSTANTLY — the cached tools are already
			// registered while the connections are still in flight.
			const echo = ext.tools?.find((t) => t.name === "mcp__fake__echo");
			const broken = ext.tools?.find((t) => t.name === "mcp__broken__x");
			expect(echo).toBeDefined();
			expect(broken).toBeDefined();
			// The FIRST call before readiness WAITS for the connect and
			// succeeds (the first-call waits-for-readiness).
			const r = await echo!.execute({ text: "pre-ready" }, ctx);
			expect(r).toEqual({ content: "pre-ready", isError: false });
			// The broken server's cached call FAILS with the connect error —
			// Disconnects are honest: never a hang, never a fake success.
			const rb = await broken!.execute({}, ctx);
			expect(rb.isError).toBe(true);
			expect(String(rb.content)).toMatch(/ENOENT|spawn|error/i);
		} finally {
			delete process.env.KISO_HOME;
			delete process.env.KISO_MCP_CONFIG;
		}
	}, 30_000);
});
});
