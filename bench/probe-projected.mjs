// probe-projected.mjs <sessions-dir> <session-id> [<at-input>]
// E6 crux calibration: print the projected token estimate of a recorded
// session EXACTLY as the run-start policy measures it (the runtime's
// session.projected() = projectMessages(log.all); estimateTokens over it)
// — the trigger value that fires at the turn-6 run's start and nowhere
// earlier. Usage: run the fixture's process 1 (turns 1-5) into a scratch
// KISO_HOME, then probe <home>/sessions <session-id>.
// Optional <at-input> N: project the state at the START of the run that
// brings the Nth user input (i.e. after N-1 inputs) — per-boundary
// measurements for sizing the trigger gap across run-to-run variance.
import { SessionStore } from "@vincemakes/kiso-runtime";
import { estimateTokens, projectMessages } from "@vincemakes/kiso-core";

const [dir, sid, atInput] = process.argv.slice(2);
if (dir === undefined || sid === undefined) {
	console.error("usage: probe-projected.mjs <sessions-dir> <session-id> [<at-input>]");
	process.exit(2);
}
const store = new SessionStore(dir);
const records = store.load(sid);
let events = records.map((r) => r.event);
if (atInput !== undefined) {
	const n = Number.parseInt(atInput, 10);
	let seen = 0, cut = events.length;
	for (let i = 0; i < events.length; i++) {
		if (events[i].type === "user_input" && ++seen === n) { cut = i; break; }
	}
	events = events.slice(0, cut);
}
const msgs = projectMessages(events);
console.log(JSON.stringify({ events: events.length, messages: msgs.length, tokens: estimateTokens(msgs), atInput: atInput ?? "end" }));
