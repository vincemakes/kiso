import { SessionStore } from "@vincemakes/kiso-runtime";

/** How many faux-script turns a session's log has consumed (the same rule the terminal's fauxSkip states: a turn is consumed by a tool
 *  result or an end_turn stop, or by an unfinished call the recovery completes). */
export function fauxSkip(sessionsDir: string, sessionId: string): number {
	const store = new SessionStore(sessionsDir);
	const events = store.load(sessionId).map((r) => r.event);
	store.closeAll();
	const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => e.callId));
	return (
		events.filter((e) => e.type === "tool_result").length +
		events.filter((e) => e.type === "stop" && e.reason === "end_turn").length +
		events.filter((e) => e.type === "tool_call_end" && !results.has(e.callId)).length
	);
}
