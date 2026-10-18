#!/usr/bin/env node
/**
 * WHAT LEVELS DOES THE SERVER ACTUALLY ACCEPT — asked of the API, not of a
 * document and not of our own registry.
 *
 * The registry recorded deepseek-v4-flash as low/high/max, dated and sourced
 * from the vendor's thinking-mode guide. The server accepts SEVEN, and says
 * so itself: sending a value it does not know returns
 *
 *   400  reasoning_effort: unknown variant `banana`, expected one of
 *        `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
 *
 * That error is the evidence (the quoting varies by server). The field is deserialized into a typed enum
 * before anything else happens, so a rejection NAMES the legal set — which
 * makes the question answerable in one request that generates no tokens,
 * rather than by reading prose that was true on some date.
 *
 * Why it matters beyond tidiness: a comparison between products at
 * different reasoning levels compares settings, not products. Aligning the
 * levels needs the real sets, and a set we copied out of documentation is
 * not one we have checked.
 *
 *   node bench/probe-effort-levels.mjs <base-url> <model> <api-key-env> [--responses] [--header name=value]...
 *
 * `--responses` probes `/responses` (the field is `reasoning.effort`) for a
 * route kiso binds as openai-responses; `--header` adds a header a gateway
 * requires (OpenCode: `x-opencode-session=probe`).
 */
import { isMain } from "../scripts/is-main.mjs";

const SENTINEL = "kiso-probe-not-a-level";

export async function probeLevels(baseUrl, model, key, { responses = false, headers = {} } = {}) {
	// max_tokens 1 and a one-word prompt: the request is REFUSED before
	// generation, so this costs nothing even when a server accepts it. (The
	// Responses API has a floor of 16 output tokens; still a few cents at most.)
	const url = `${baseUrl.replace(/\/$/, "")}/${responses ? "responses" : "chat/completions"}`;
	const request = responses
		? { model, max_output_tokens: 16, input: "hi", reasoning: { effort: SENTINEL } }
		: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }], reasoning_effort: SENTINEL };
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
		body: JSON.stringify(request),
	});
	const body = await res.json().catch(() => ({}));
	const message = body?.error?.message ?? "";
	if (res.status === 200) {
		return { status: res.status, levels: null, why: "the server ACCEPTED a nonsense level — it does not validate this field, so its legal set cannot be read this way" };
	}
	// `expected one of \`a\`, \`b\`, ...` — the shape every serde enum error takes.
	// backticks (`a`, `b`: serde) or double quotes ("a"|"b": a zod-style enum)
	const listed = [...message.matchAll(/[`"]([a-z-]+)[`"]/g)].map((m) => m[1]).filter((v) => v !== SENTINEL);
	if (listed.length === 0) {
		return { status: res.status, levels: null, why: `refused, but named no set: ${message.slice(0, 160)}` };
	}
	return { status: res.status, levels: listed, why: null, raw: message.slice(0, 200) };
}

if (isMain(import.meta.url)) {
	const args = process.argv.slice(2);
	const responses = args.includes("--responses");
	const headers = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--header") continue;
		const [name, ...rest] = String(args[i + 1] ?? "").split("=");
		if (!name || rest.length === 0) { console.error("--header takes name=value"); process.exit(2); }
		headers[name] = rest.join("=");
	}
	const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--header");
	const [baseUrl, model, keyEnv] = positional;
	if (baseUrl === undefined || model === undefined || keyEnv === undefined) {
		console.error("usage: probe-effort-levels.mjs <base-url> <model> <api-key-env> [--responses] [--header name=value]...");
		process.exit(2);
	}
	const key = process.env[keyEnv];
	if (!key) { console.error(`${keyEnv} is not set`); process.exit(2); }
	console.log(JSON.stringify(await probeLevels(baseUrl, model, key, { responses, headers }), null, 1));
}
