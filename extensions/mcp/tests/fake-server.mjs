/**
 * ③ — the in-repo fake MCP server (real SDK Server, stdio transport).
 * Exposes the four probe tools the bridge tests need:
 *   echo       — echoes its `text` argument
 *   env_probe  — echoes the named environment variable ("" when absent)
 *   fail       — returns isError: true
 *   slow       — sleeps 5s then returns
 *
 * P2 (测试卫生): an optional run-id argv rides in the process command line
 * so an ORPHAN check can pgrep THIS server uniquely — the machine-wide
 * "fake-server.mjs" pattern would catch a parallel test's live server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// eslint-disable-next-line no-unused-vars
const RUN_ID = process.argv[2] ?? null; // carried for the orphan check only

// 手感批 A3: the noise probe — a real-world MCP server announces itself on
// stderr at startup. Printed BEFORE the handshake so the ordering is
// deterministic: the e2e asserts it never reaches the host terminal around
// the banner (it lands in the mcp__status stderr tail instead).
console.error("fake-server: running on stdio (ready)");

const server = new McpServer({ name: "fake", version: "0.1.0" }, { capabilities: { tools: {} } });

server.registerTool(
	"echo",
	{ description: "Echo the given text", inputSchema: { text: z.string() } },
	async ({ text }) => ({ content: [{ type: "text", text: String(text) }] }),
);

server.registerTool(
	"env_probe",
	{ description: "Echo the named environment variable", inputSchema: { name: z.string() } },
	async ({ name }) => ({ content: [{ type: "text", text: process.env[name] ?? "" }] }),
);

server.registerTool(
	"fail",
	{ description: "Always fails" },
	async () => ({ content: [{ type: "text", text: "intentional failure" }], isError: true }),
);

server.registerTool(
	"slow",
	{ description: "Sleeps five seconds" },
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		return { content: [{ type: "text", text: "slow done" }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
