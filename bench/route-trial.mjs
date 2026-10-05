#!/usr/bin/env node
/**
 * route-trial.mjs <work> — the gate a new ROUTE passes before a paired
 * round spends anything on it (kiso-doc plan-0460-3f-evaluation, rev 2).
 * Read from ONE trial leg's main session log; every check must hold:
 *
 *   reasoningRoundTrip  a tool-calling turn was followed by another model
 *                       request that completed — DeepSeek refuses a turn
 *                       whose reasoning was not replayed, so a gateway that
 *                       drops `reasoning_content` ends the run in an error
 *   cacheReads          some request after the first read from the cache
 *   oneUsagePerRequest  usage events equal requests (the double-usage
 *                       stream 0.45.1 fixed would show as more)
 *   completed           the leg's last run ended `completed`
 *
 * Prints the verdict as JSON; exits 0 when every check holds, 1 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";

export function trial(events) {
	const stops = events.filter((e) => e.type === "stop");
	const usages = events.filter((e) => e.type === "usage");
	const toolTurn = stops.findIndex((e) => e.reason === "tool_use");
	const terminals = events.filter((e) => e.type === "terminal");
	const last = terminals.at(-1);
	const checks = {
		reasoningRoundTrip: toolTurn >= 0 && stops.length > toolTurn + 1,
		cacheReads: usages.slice(1).some((u) => typeof u.cacheRead === "number" && u.cacheRead > 0),
		oneUsagePerRequest: stops.length > 0 && usages.length === stops.length,
		completed: last?.outcome?.kind === "completed",
	};
	return { ok: Object.values(checks).every(Boolean), checks, requests: stops.length, usageEvents: usages.length, lastOutcome: last?.outcome?.kind ?? null };
}

export function trialOf(work) {
	const dir = join(work, "kiso-home", "sessions");
	const logs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("sub-")) : [];
	if (logs.length !== 1) return { ok: false, error: `expected one main session log in ${dir}, found ${logs.length}` };
	const events = readFileSync(join(dir, logs[0]), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l).event);
	return trial(events);
}

if (isMain(import.meta.url)) {
	const verdict = trialOf(process.argv[2]);
	console.log(JSON.stringify(verdict, null, 1));
	process.exit(verdict.ok ? 0 : 1);
}
