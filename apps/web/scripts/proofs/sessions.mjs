// ADR-0062 PR 1: list_sessions. With KISO_WEB_SESSIONS=on a new Work is marked and lists the others across folders, a query
// narrows them; a Work made with it off (or in the terminal) keeps a table without it, even opened by a host that has it on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@vincemakes/kiso-client";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("sessions");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const list = (callId, input) => ({ events: [{ type: "tool_call_end", callId, name: "list_sessions", input }, { type: "stop", reason: "tool_use" }] });
const data = scratch("sessions-data");
const [wsA, wsB] = [scratch("sessions-a"), scratch("sessions-b")];
const done = async (s, text) => (await s.run(text), await waitUntil(async () => !(await s.state()).running, 8000));
// the wire leaves a result's text out of replay: read the Work's own log
const result = (key, id, callId) => readFileSync(join(data, "projects", key, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event).find((e) => e.type === "tool_result" && e.callId === callId);
const marked = (key, id) => {
	try {
		return JSON.parse(readFileSync(join(data, "projects", key, `${id}.meta.json`), "utf8")).sessionsTools === true;
	} catch {
		return false;
	}
};

const a = await launch({ data, workspace: wsA, fauxScript: [say("A done.")] });
await done(clientFor(a).session("work-a"), "alpha task in folder A");
a.child.kill("SIGTERM");
await new Promise((r) => a.child.once("exit", r));

const b = await launch({ data, workspace: wsB, env: { KISO_WEB_SESSIONS: "on" }, fauxScript: [list("l1", {}), say("Listed."), list("l2", { query: "ALPHA" }), say("Found."), list("l3", { query: "nothing like it" }), say("None."), list("l4", {}), say("Unknown.")] });
const hist = await fetch(`${b.origin}/desk/history`, { headers: { authorization: `Bearer ${b.token}` } }).then((r) => r.json());
const wb = clientFor(b).session("work-b");
await done(wb, "beta task in folder B");
const keyB = hist.current.key;
const all = result(keyB, "work-b", "l1");
check(all !== undefined && !all.isError && /^1 session:/.test(all.content), "a new Work lists the other Work, not itself");
check(/^- alpha task in folder A · ref rk-a · folder kiso-web-sessions-a-\w+ · idle · active just now$/m.test(all.content), "one line: title, short ref, folder, state, last activity");
check(marked(keyB, "work-b"), "the new Work is marked in its sidecar");
await done(wb, "find alpha");
check(/^1 session matching "ALPHA":/.test(result(keyB, "work-b", "l2").content), "query matches a title in any case");
await done(wb, "find nothing");
check(result(keyB, "work-b", "l3").content === 'No session matches "nothing like it".', "a query that matches nothing says so");
const keyA = (await fetch(`${b.origin}/desk/history`, { headers: { authorization: `Bearer ${b.token}` } }).then((r) => r.json())).works.find((w) => w.id === "work-a").key;
const oa = createClient({ baseUrl: `${b.origin}/w/${keyA}/v1/sessions`, headers: () => ({ authorization: `Bearer ${b.token}` }) }).session("work-a");
await done(oa, "list from A");
const l4 = result(keyA, "work-a", "l4");
check(!marked(keyA, "work-a") && l4.isError && /unknown tool/i.test(l4.content), "a Work made with the tools off keeps its table: opened by a host that has them on, it has no list_sessions");
b.child.kill("SIGKILL");
verdict();
