#!/usr/bin/env node
/**
 * round-spend.mjs <round-dir> — what a round has spent so far, in dollars,
 * from every leg's own usage events (children included), at the route's
 * stated rates. The paired runner stops a round when this passes its cap.
 *
 * Rates per million tokens — DeepSeek V4.1 Flash, which Command Code bills
 * at DeepSeek's own prices (read 2026-09-17): input $0.15, cache read
 * $0.003, output $0.60. `inputTokens` is the whole prompt, cache included
 * (the census's unit), so fresh = input − cacheRead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";

export const RATES = { input: 0.15, cacheRead: 0.003, output: 0.6 };

export function legSpend(work) {
	const dir = join(work, "kiso-home", "sessions");
	if (!existsSync(dir)) return 0;
	let fresh = 0;
	let cache = 0;
	let out = 0;
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			let e;
			try {
				e = JSON.parse(line).event;
			} catch {
				continue;
			}
			if (e?.type !== "usage" || typeof e.inputTokens !== "number") continue;
			const c = typeof e.cacheRead === "number" ? e.cacheRead : 0;
			fresh += e.inputTokens - c;
			cache += c;
			out += typeof e.outputTokens === "number" ? e.outputTokens : 0;
		}
	}
	return (fresh * RATES.input + cache * RATES.cacheRead + out * RATES.output) / 1e6;
}

export function roundSpend(round) {
	if (!existsSync(round)) return 0;
	return readdirSync(round)
		.filter((d) => d.startsWith("kiso-"))
		.reduce((sum, d) => sum + legSpend(join(round, d)), 0);
}

if (isMain(import.meta.url)) {
	console.log(roundSpend(process.argv[2]).toFixed(4));
}
