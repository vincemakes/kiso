#!/usr/bin/env node
/**
 * repro-host-cold-start.mjs <kiso install prefix> [tools=13] — the HOST path of
 * the cold-start finding: a program that uses kiso as a library and passes its
 * MCP servers to createMcpExtension({ servers }), which by its documented
 * contract neither reads nor writes the tool cache.
 *
 * For each of three separate processes ("host starts") it builds an agent with
 * the mock MCP server, opens a session, runs two turns back to back against a
 * local OpenAI-compatible sink, and prints how many tools of the MCP server the
 * model was offered in the FIRST and the SECOND request. No model, no network,
 * no spend; a few seconds.
 *
 * What it tests: (1) is the first request of every host process free of MCP
 * tools; (2) do later requests of the same process have them; (3) does a second
 * host start in the same working directory fare any better.
 *
 *   <prefix>  an npm prefix with @vincemakes/kiso-runtime and kiso-mcp-ext
 *             installed (the published 0.48.0 for the finding).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [PREFIX, TOOLS = "13", WORKER, ROOT, URL_] = process.argv.slice(2);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

if (WORKER === "--worker") {
	// one host start: runs inside its own process
	const pkg = (n, f) => pathToFileURL(join(PREFIX, "node_modules/@vincemakes", n, f)).href;
	const { createAgent, SessionStore } = await import(pkg("kiso-runtime", "dist/index.js"));
	const createMcpExtension = (await import(pkg("kiso-mcp-ext", "dist/kiso-mcp.mjs"))).default;
	const ext = await createMcpExtension({ servers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: TOOLS } } } });
	const agent = createAgent({ model: "m", provider: "openai-compat", baseUrl: URL_, apiKey: "x", tools: [], store: new SessionStore(join(ROOT, "sessions")), extensions: [ext], systemPrompt: "You are a test agent." });
	const session = await agent.session({ id: "host" });
	const waitMs = Number(process.env.HOST_WAIT_MS ?? 0);
	if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
	for (const text of ["say hi", "say hi again"]) for await (const ev of session.run(text)) if (ev.type === "terminal") break;
	process.exit(0);
}

const { startFakeLlm } = await import("./fake-llm.mjs");
const root = mkdtempSync(join(tmpdir(), "mcp-host-"));
for (const start of [1, 2, 3]) {
	const dir = join(root, `start-${start}`); mkdirSync(dir, { recursive: true });
	const llm = await startFakeLlm(join(dir, "req"));
	const p = spawn(process.execPath, [fileURLToPath(import.meta.url), PREFIX, TOOLS, "--worker", dir, llm.url], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH, HOME: join(dir, "h"), KISO_HOME: join(root, "kiso-home"), HOST_WAIT_MS: process.env.HOST_WAIT_MS ?? "0", FAKE_LLM_DELAY_MS: process.env.FAKE_LLM_DELAY_MS ?? "0" } });
	let err = ""; p.stderr.on("data", (c) => { err += c; });
	const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }, 60_000);
	await new Promise((r) => p.on("exit", r)); clearTimeout(t); try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ }
	const count = (n) => { try { const b = JSON.parse(readFileSync(join(dir, "req", `req-${n}.json`), "utf8")); const names = (b.tools ?? []).map((x) => x.function?.name ?? x.name); return `${names.length} tools, ${names.filter((x) => x.startsWith("mcp__studio__")).length} from the MCP server`; } catch { return "no request"; } };
	console.log(`host start ${start}: first request: ${count(1)}; second request: ${count(2)}${err.trim() ? `   [stderr: ${err.trim().slice(0, 160)}]` : ""}`);
	await llm.close();
}
console.log(`tool cache file written by the host path: ${existsSync(join(root, "kiso-home", "mcp-tools.json")) ? "yes" : "no"}`);
