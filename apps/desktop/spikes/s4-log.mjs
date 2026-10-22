// Line 4, real run: read a session log the terminal wrote and say what the
// desktop's usage frame would have said, for comparison with the recap the
// terminal printed for that run.  node s4-log.mjs <session.jsonl> <route>
import { readFileSync } from "node:fs";
import { runTotals } from "../dist/main/usage.js";

const [file, route = "openai-compat"] = process.argv.slice(2);
const events = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l).event)
	.filter(Boolean);
const terminal = events.filter((e) => e.type === "terminal").at(-1);
const totals = runTotals(events, terminal.seq, route);
const fmt = (n) => (n < 1000 ? String(n) : `${(Math.round(n / 100) / 10).toFixed(1)}k`);
console.log(`usage events in the log: ${events.filter((e) => e.type === "usage").length}, calls ${totals.calls}`);
console.log(`desktop frame says: fresh ${fmt(totals.fresh)} out ${fmt(totals.output)} · cache ${Math.round(totals.cacheRate)}%   (raw ${JSON.stringify(totals)})`);
