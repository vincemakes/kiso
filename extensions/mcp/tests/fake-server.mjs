/**
 * ③ — the in-repo fake MCP server (real SDK Server, stdio transport).
 * Exposes the four probe tools the bridge tests need:
 *   echo       — echoes its `text` argument
 *   env_probe  — echoes the named environment variable ("" when absent)
 *   fail       — returns isError: true
 *   slow       — sleeps 5s then returns
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
