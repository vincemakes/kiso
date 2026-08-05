/**
 * kiso(基礎) official MCP bridge — ③: an extension, kernel untouched.
 *
 * Reads ${KISO_MCP_CONFIG:-~/.kiso/mcp.json} and turns every configured MCP
 * server's tools into kiso tools named mcp__<server>__<tool>. Stdio servers
 * spawn with provider credentials STRIPPED (the same list as tools-node's
 * shell tool — keep in sync) plus the config's explicit env (which may
 * deliberately re-add a variable); url servers use
 * StreamableHTTPClientTransport. A server that fails to connect is a SOFT
 * failure: its error lands in mcp__status and the other servers keep
 * working. No approval auto-allow: mcp__ tools fall in the ask tier —
 * external tools must pass human review (write your own policy to allow
 * specific ones). ctx.signal cancels in-flight calls; one call times out
 * after CALL_TIMEOUT_MS.
 *
 * Built with esbuild into a self-contained dist/kiso-mcp.mjs (the SDK is
 * inlined) — drop the file into ~/.kiso/extensions/ and restart.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { KisoExtension, Tool, ToolContext, ToolResult } from "@vincemakes/kiso-core";

/** Default single-call timeout (ms) — an external tool must never hang the
 *  agent forever. */
const CALL_TIMEOUT_MS = 60_000;
/** Per-server connect timeout (ms) — 发现#8b: a server that does not
 *  answer the handshake is a SOFT failure (mcp__status), never a hung
 *  startup. */
const CONNECT_TIMEOUT_MS = 15_000;

interface McpServerConfig {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly disabled?: boolean;
}

interface McpConfig {
	readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

interface ServerStatus {
	readonly server: string;
	readonly state: "connected" | "error" | "idle";
	readonly detail: string;
}

/** 发现#11: KISO_HOME is the ONE root — the default config path derives
 *  from it (KISO_MCP_CONFIG still overrides). */
function kisoHome(): string {
	return process.env.KISO_HOME ?? join(homedir(), ".kiso");
}

export default async function createMcpExtension(): Promise<KisoExtension> {
	const config = readConfig(process.env.KISO_MCP_CONFIG ?? join(kisoHome(), "mcp.json"));
	const status: ServerStatus[] = [];
	const tools: Tool[] = [statusTool(status)];
	const clients: Client[] = [];
	for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
		if (server.disabled === true) continue;
		try {
			const mapped = await connectServer(name, server, clients);
			status.push({ server: name, state: "connected", detail: `${mapped.length} tools` });
			tools.push(...mapped);
		} catch (err) {
			status.push({ server: name, state: "error", detail: err instanceof Error ? err.message : String(err) });
		}
	}
	if (status.length === 0) status.push({ server: "(none)", state: "idle", detail: "no MCP servers configured" });
	return {
		name: "mcp",
		tools,
		// 发现#8 (P1): the LOADER calls this on exit — closing every client
		// terminates its transport (the stdio children end; a hung process
		// would otherwise keep the host alive forever).
		dispose: async () => {
			await Promise.allSettled(clients.map((client) => client.close()));
		},
	};
}

/** Absent config file = no servers = no tools, never an error; a present
 *  but broken/invalid config throws LOUDLY (the E1 loader convention). */
function readConfig(path: string): McpConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`[mcp] cannot parse ${path}: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`[mcp] ${path} must be an object with an mcpServers map`);
	}
	const cfg = parsed as McpConfig;
	for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
		if (typeof server !== "object" || server === null || Array.isArray(server)) {
			throw new Error(`[mcp] server "${name}" must be an object`);
		}
		if (server.disabled !== true && server.command === undefined && server.url === undefined) {
			throw new Error(`[mcp] server "${name}" needs a command (stdio) or a url`);
		}
	}
	return cfg;
}

/** The zero-arg status tool: connection state is runtime info and the CLI
 *  has no new UI for it — the tool itself presents it (the cost of zero
 *  kernel changes, stated). */
function statusTool(status: readonly ServerStatus[]): Tool {
	return {
		name: "mcp__status",
		description: "list MCP server connection status",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: status.map((s) => `${s.server}: ${s.state} — ${s.detail}`).join("\n"),
			isError: false,
		}),
	};
}

async function connectServer(name: string, cfg: McpServerConfig, clients: Client[]): Promise<Tool[]> {
	const client = new Client({ name: "kiso-mcp", version: "0.1.7" });
	clients.push(client);
	if (cfg.url !== undefined) {
		const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
			...(cfg.headers !== undefined ? { requestInit: { headers: { ...cfg.headers } } } : {}),
		});
		// The SDK's own transports are structurally `Transport`; their
		// optional-property declarations do not satisfy this project's
		// exactOptionalPropertyTypes, so the SDK's interface is asserted.
		await connectWithTimeout(client, transport);
	} else {
		// Provider credentials are stripped (the tools-node #7 list — keep in
		// sync), then the config's explicit env overlays it (explicit wins).
		const env = { ...strippedEnv(), ...(cfg.env ?? {}) };
		const transport = new StdioClientTransport({
			command: cfg.command!,
			...(cfg.args !== undefined ? { args: [...cfg.args] } : {}),
			env,
			...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
		});
		await connectWithTimeout(client, transport);
	}
	const { tools } = await client.listTools();
	return tools.map((t) => mapTool(name, client, t));
}

/** 发现#8b: the handshake is bounded — a server that never answers the
 *  initialize exchange times out and becomes a SOFT failure, exactly like
 *  an unreachable one. */
async function connectWithTimeout(client: Client, transport: StdioClientTransport | StreamableHTTPClientTransport): Promise<void> {
	await Promise.race([
		client.connect(transport as unknown as Transport),
		// unref'd: when the handshake wins the race, the abandoned timeout
		// must not hold the host's event loop (发现#8: prompt exits).
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS).unref(),
		),
	]);
}

function mapTool(server: string, client: Client, mcpTool: { name: string; description?: string | undefined; inputSchema?: unknown }): Tool {
	return {
		name: `mcp__${server}__${mcpTool.name}`,
		description: mcpTool.description ?? `${server}: ${mcpTool.name}`,
		parameters: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as Readonly<Record<string, unknown>>,
		execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
			try {
				const result = await client.callTool(
					{ name: mcpTool.name, arguments: (input ?? {}) as Record<string, unknown> },
					undefined,
					{ signal: ctx.signal as AbortSignal, timeout: CALL_TIMEOUT_MS },
				);
				return { content: renderResult(result.content as readonly unknown[]), isError: result.isError === true };
			} catch (err) {
				return { content: err instanceof Error ? err.message : String(err), isError: true, errorKind: "fatal" };
			}
		},
	};
}

/** MCP content blocks → text: text passes through VERBATIM; anything else
 *  becomes an explicit marker line — an honest conversion, never a silent
 *  drop. */
function renderResult(content: readonly unknown[]): string {
	return content
		.map((block) => {
			const b = block as { type?: string; text?: string; mimeType?: string; kind?: string };
			if (b.type === "text") return b.text ?? "";
			return `[MCP ${b.type ?? "unknown"} content: ${b.mimeType ?? b.kind ?? "?"}]`;
		})
		.join("");
}

/** Provider credentials stripped from stdio children — the SAME list as
 *  tools-node's shell tool (packages/tools-node/src/index.ts
 *  SHELL_STRIP_EXACT / strippedShellEnv); keep in sync. */
const STRIP_EXACT = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_BASE_URL",
	"OPENAI_BASE_URL",
	"ANTHROPIC_MODEL",
	"OPENAI_MODEL",
];
function strippedEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (STRIP_EXACT.includes(key)) continue;
		if (key.endsWith("_API_KEY") || key.endsWith("_AUTH_TOKEN")) continue;
		if (value !== undefined) out[key] = value;
	}
	return out;
}
