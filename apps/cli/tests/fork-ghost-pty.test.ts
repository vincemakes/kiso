/**
 * REL-0530-F1 through the real TUI: the follow-up ghost belongs to the session it was asked of. After /fork
 * switches, the box shows no ghost the parent's last reply produced: the fork ends at the reply picked, so a ghost
 * about a later reply would offer a question about work the fork never did. The same seam serves /resume and /clear.
 *
 * The parent runs against a loopback openai-compat stub in its own process (the pty driver blocks this one): the
 * first request is the run and answers REPLY-ONE, every later request is the follow-up and answers the ghost line.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const STUB = `
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [portFile] = process.argv.slice(2);
let n = 0;
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const parsed = JSON.parse(body);
		const text = n++ === 0 ? "REPLY-ONE" : "PARENT-GHOST-LINE";
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish) => res.write("data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish !== null ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) }) + "\\n\\n");
		chunk({ role: "assistant", content: text }, null);
		chunk({}, "stop");
		res.write("data: [DONE]\\n\\n");
		res.end();
	});
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
`;

describe("REL-0530-F1 — a session switch clears the follow-up ghost", () => {
	it("after /fork switches, the parent's ghost is not drawn in the fork's box", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-fork-ghost-"));
		writeFileSync(join(dir, "stub.mjs"), STUB, "utf8");
		const portFile = join(dir, "port");
		const stub = spawn(process.execPath, [join(dir, "stub.mjs"), portFile], { stdio: "ignore" });
		try {
			for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
			const base = `http://127.0.0.1:${readFileSync(portFile, "utf8")}/v1`;
			const { env, dirs } = isolatedEnv({ F1_KEY: "k-test" });
			delete env.KISO_FOLLOWUP;
			writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify({ model: "gw", models: { gw: { kind: "openai-compat", model: "m", apiKeyEnv: "F1_KEY", baseUrl: base } } })}\n`, "utf8");
			const out = strip(
				ptyRun(["--mode", "bypass", "f1-parent"], env as NodeJS.ProcessEnv, {
					feeds: [
						["/mode to switch", "hello\r"],
						// the cursor sits on the ghost's first character (drawn reversed), so the needle starts at the second
						["ARENT-GHOST-LINE", "/fork\r"],
						["fork after a reply", "\r"],
						["forked", "exit\r"],
					],
					timeout: 60,
				}),
			);
			expect(out, "the parent drew its ghost").toContain("ARENT-GHOST-LINE");
			const after = out.slice(out.lastIndexOf("forked"));
			expect(after, "the fork's box carries no ghost of the parent's").not.toContain("ARENT-GHOST-LINE");
		} finally {
			stub.kill();
		}
	}, 120_000);
});
