#!/usr/bin/env node
/**
 * leg-config.mjs <arm> <tools> <volume> <outDir> <snapshot> — write one leg's
 * MCP overlay into <outDir> (the BENCH_OVERLAY directory run-t6.sh reads):
 *
 *   mcp.json        the mock server as this arm's user-level MCP configuration
 *                   (P-direct / P-deferred / P-codemode differ ONLY in `exposure`)
 *   mcp-tools.json  kiso arm only: the tool cache kiso writes after a successful
 *                   connect ($KISO_HOME/mcp-tools.json). Without it kiso presents
 *                   MCP tools only after the background connect settles, so a
 *                   cold first request has none (measured 2026-10-10). The
 *                   benchmark models steady-state use, where the cache exists;
 *                   the cold start is a finding about the bridge, not a cost
 *                   this benchmark should charge to the arm. It is generated
 *                   from the server's own tools/list, byte-for-byte what the
 *                   bridge would have written.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [arm, tools, volume, outDir, snapshot] = process.argv.slice(2);
if (!arm || !tools || !volume || !outDir || !snapshot) { console.error("usage: leg-config.mjs <P-direct|P-deferred|P-codemode|K-direct> <tools> <volume> <outDir> <snapshot>"); process.exit(2); }
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const EXPOSURE = { "P-direct": "direct", "P-deferred": "deferred", "P-codemode": "codemode", "P-codemode-only": "codemode" };
if (!(arm in EXPOSURE) && !arm.startsWith("K-")) { console.error(`unknown arm ${arm}`); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const server = {
	command: process.execPath, args: [SERVER],
	env: { MCP_TOOLS: tools, MCP_VOLUME: volume, MCP_SNAPSHOT: snapshot },
	...(arm in EXPOSURE ? { exposure: EXPOSURE[arm], description: "Studio production tools: projects, subjects, assets, board, approval, credits, plus workspace services" } : {}),
};
writeFileSync(join(outDir, "mcp.json"), `${JSON.stringify({ mcpServers: { studio: server } }, null, 1)}\n`);

if (arm === "K-direct") {
	// the cache must come from a server that does not touch the leg's snapshot
	const p = spawn(process.execPath, [SERVER], { env: { ...process.env, MCP_TOOLS: tools, MCP_VOLUME: volume, MCP_SNAPSHOT: "" }, stdio: ["pipe", "pipe", "inherit"] });
	const list = await new Promise((resolve) => {
		createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); if (m.id === 1) resolve(m.result.tools); });
		p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
	});
	p.stdin.end();
	writeFileSync(join(outDir, "mcp-tools.json"), JSON.stringify({ studio: list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
}
