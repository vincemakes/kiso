/**
 * fake-llm.mjs — a local OpenAI-compatible chat-completions endpoint that
 * records every request body and answers one short assistant message. It
 * exists so an arm can be started, its FIRST request read (tool table, system
 * prompt, size) and its configuration validated with no model and no spend.
 *
 * startFakeLlm(outDir) -> { url, close() }; bodies land in outDir/req-<n>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export function startFakeLlm(outDir, { reply = "done", delayMs = Number(process.env.FAKE_LLM_DELAY_MS ?? 0) } = {}) {
	mkdirSync(outDir, { recursive: true });
	let n = 0;
	const srv = createServer((req, res0) => {
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", () => setTimeout(() => {
			const res = res0;
			if (!/chat\/completions/.test(req.url)) { res.writeHead(404); res.end("{}"); return; }
			n += 1;
			writeFileSync(join(outDir, `req-${n}.json`), body);
			let stream = true; try { stream = JSON.parse(body).stream !== false; } catch { /* keep */ }
			const base = { id: `fake-${n}`, object: "chat.completion.chunk", created: 0, model: "fake" };
			const usage = { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 };
			if (!stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage })); return; }
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
			res.write("data: [DONE]\n\n"); res.end();
		}, delayMs));
	});
	return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}/v1`, count: () => n, close: () => new Promise((r) => srv.close(r)) })));
}
