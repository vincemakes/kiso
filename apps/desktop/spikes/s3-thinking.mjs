// Line 3: thinking on the wire. (a) a faux run whose thinking arrives in
// small deltas, through the host, with the page's pager; (b) the same pager
// over the deltas of a REAL run, replayed with their original timing
// (captured by the scratch script; see the report for the request count).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript, EVIDENCE } from "./lib.mjs";
import { ThinkingPager } from "../dist/shared/thinking.js";

const out = transcript("s3-thinking");
const think = (text) => ({ type: "thinking", text });
const chunks = "The user asks for a rename. I should first find every use of the old name. Then I will change them one by one.\n\nAfter that I need to run the tests. If one fails I will read the failure before touching anything else.\n\nFinally I will summarize what changed and what I did not touch.".match(/.{1,9}/gs);
const script = [{ events: [...chunks.map(think), { type: "text_delta", text: "ok" }, { type: "usage", inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] }];

out("=== (a) faux deltas through the host, with exposeThinking on");
const host = await launch({ data: scratch("s3-data"), workspace: scratch("s3-ws"), fauxScript: script, env: { KISO_DESKTOP_ALLOW_ALL: "1" } });
const pager = new ThinkingPager();
let n = 0;
for await (const ev of clientFor(host).session("think").runStream("rename it")) {
	if (ev.kind !== "event") continue;
	if (ev.event.type === "thinking") {
		n += 1;
		for (const p of pager.push(ev.event.text)) out(`  after delta ${String(n).padStart(2)}: ${p.kind.padEnd(9)} #${p.paragraph} ${JSON.stringify(p.text).slice(0, 110)}`);
	}
}
for (const p of pager.flush()) out(`  flush         : ${p.kind.padEnd(9)} #${p.paragraph} ${JSON.stringify(p.text).slice(0, 110)}`);
out(`${n} thinking events delivered to the client`);
host.child.kill("SIGTERM");

out("=== (a2) the same script with exposeThinking off");
const off = await launch({ data: scratch("s3-data-off"), workspace: scratch("s3-ws-off"), fauxScript: script, env: { KISO_DESKTOP_ALLOW_ALL: "1", KISO_DESKTOP_THINKING: "0" } });
const typesOff = [];
for await (const ev of clientFor(off).session("think").runStream("rename it")) if (ev.kind === "event") typesOff.push(ev.event.type);
out(`  wire events with exposeThinking off: ${typesOff.join(" ")}  (thinking events: ${typesOff.filter((t) => t === "thinking").length})`);
off.child.kill("SIGTERM");

const realFile = join(EVIDENCE, "s3-real-thinking-deltas.json");
if (existsSync(realFile)) {
	out("=== (b) the deltas of a real run, replayed with their original timing");
	const deltas = JSON.parse(readFileSync(realFile, "utf8"));
	const real = new ThinkingPager();
	deltas.forEach((d, i) => {
		for (const p of real.push(d.text)) out(`  +${String(d.t).padStart(5)} ms (delta ${String(i + 1).padStart(3)}): ${p.kind.padEnd(9)} #${p.paragraph} ${JSON.stringify(p.text).slice(0, 110)}`);
	});
	for (const p of real.flush()) out(`  flush: ${p.kind.padEnd(9)} #${p.paragraph} ${JSON.stringify(p.text).slice(0, 110)}`);
	out(`${deltas.length} real thinking deltas, ${deltas.reduce((a, d) => a + d.text.length, 0)} chars, from ${deltas[0]?.t} ms to ${deltas.at(-1)?.t} ms after the request`);
}
