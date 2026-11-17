// ADR-0062 § 9: a turn another Work's message started cannot start a Work. Research messages Docs; Docs wakes, and its
// start_session ("asked") is refused with the reason: no Work is made, no card drawn, no parent link written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("start-refused");
const okay = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const call = (callId, name, input) => ({ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] });
const data = scratch("start-refused-data");
const host = await launch({ data, workspace: scratch("start-refused-ws"), env: { KISO_WEB_SESSIONS: "on" }, fauxScript: [okay, okay, call("m1", "message", { to: "Docs", text: "Start a Work for the parser." }), call("s1", "start_session", { title: "Parser", brief: "Build the parser.", initiation: "asked" }), okay, okay] });
const auth = { authorization: `Bearer ${host.token}` };
const desk = (path) => fetch(`${host.origin}${path}`, { headers: auth }).then((r) => r.json());
const key = (await desk("/desk/history")).current.key;
const events = (id) => readFileSync(join(data, "projects", key, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const done = async (id, text) => (await clientFor(host).session(id).run(text), await waitUntil(async () => !(await clientFor(host).session(id).state()).running, 8000));
await done("w-docs", "Docs");
await done("w-res", "Research");
await done("w-res", "ask Docs to start a parser Work");
await waitUntil(() => events("w-docs").some((e) => e.type === "tool_result" && e.callId === "s1"), 8000);
const woke = events("w-docs").find((e) => e.type === "user_input" && e.via?.kind === "peer");
const result = events("w-docs").find((e) => e.type === "tool_result" && e.callId === "s1");
check(woke?.via.from === `${key}/w-res`, "Docs' turn was started by Research's message");
check(result?.isError === true && result.content.startsWith("Refused: this turn was started by another session's message"), "its start_session is refused with the reason");
const works = (await desk(`/desk/history?fresh=${key}`)).works;
check(works.length === 2 && !works.some((w) => w.parent !== undefined), "no Work was made, and none is anyone's child");
check(Object.keys((await desk(`/desk/env?key=${key}&session=w-docs`)).cards ?? {}).length === 0, "no card was drawn");
host.child.kill("SIGKILL");
verdict();
