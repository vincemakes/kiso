// ADR-0062 PR 2: message. One Work messages an idle one by title: it lands in the receiver's inbox, wakes it, is admitted
// once as a message (never the person's line) and the file goes; an unknown name and a file the sender may not read are refused.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("messages");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const call = (callId, input) => ({ events: [{ type: "tool_call_end", callId, name: "message", input }, { type: "stop", reason: "tool_use" }] });
const data = scratch("messages-data");
const ws = scratch("messages-ws");
const outside = join(scratch("messages-outside"), "secret.txt");
writeFileSync(outside, "not yours");
writeFileSync(join(ws, "notes.md"), "shared notes");
const done = async (s, text) => (await s.run(text), await waitUntil(async () => !(await s.state()).running, 8000));
const events = (key, id) => readFileSync(join(data, "projects", key, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const result = (key, id, callId) => events(key, id).find((e) => e.type === "tool_result" && e.callId === callId);

const host = await launch({
	data,
	workspace: ws,
	env: { KISO_WEB_SESSIONS: "on" },
	fauxScript: [say("Ready."), call("m0", { to: "no such session", text: "x" }), call("m1", { to: "receiver", text: "x", files: [outside] }), call("m2", { to: "RECEIVER TASK", text: "the API changed; see the notes", files: [join(ws, "notes.md")] }), say("Done."), say("Done.")],
});
const key = (await fetch(`${host.origin}/desk/history`, { headers: { authorization: `Bearer ${host.token}` } }).then((r) => r.json())).current.key;
await done(clientFor(host).session("w-recv"), "receiver task");
await done(clientFor(host).session("w-send"), "sender task");
check(/No session is called "no such session"/.test(result(key, "w-send", "m0").content) && result(key, "w-send", "m0").isError, "an unknown name is refused, naming list_sessions");
check(/may not read it/.test(result(key, "w-send", "m1").content), "a file outside the sender's folders is refused");
check(/^Sent to "receiver task"/.test(result(key, "w-send", "m2").content), "a title in any case reaches the receiver");
await waitUntil(() => events(key, "w-recv").some((e) => e.type === "terminal" && e.seq > 3), 8000);
const admitted = events(key, "w-recv").filter((e) => e.type === "user_input" && e.via?.kind === "peer");
check(admitted.length === 1 && admitted[0].source === "system" && admitted[0].via.from === `${key}/w-send`, "the idle receiver woke and admitted it once, as a message from the sender");
check(admitted[0].content.includes("the API changed") && admitted[0].content.includes(join(ws, "notes.md")), "the model reads the text and the file's path");
await waitUntil(() => readdirSync(join(data, "projects", key, "w-recv.inbox")).every((n) => !n.endsWith(".json")), 8000);
check(true, "once admitted, the inbox file is gone");
host.child.kill("SIGKILL");
verdict();
