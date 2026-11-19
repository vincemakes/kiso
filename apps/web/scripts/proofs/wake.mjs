// ADR-0062 PR 3: a Work another started reports back when its run ends: the idle parent wakes and reads a completion notice
// (the run's end state and its reply), as a message, never the person's line. A message to a Work that reaches further than
// its sender (here: a folder the sender was not given) is held for the person: it waits in the inbox, delivered to no one.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("wake");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const call = (callId, input) => ({ events: [{ type: "tool_call_end", callId, name: "message", input }, { type: "stop", reason: "tool_use" }] });
const data = scratch("wake-data");
const ws = scratch("wake-ws");
const extra = scratch("wake-extra");
const done = async (s, text) => (await s.run(text), await waitUntil(async () => !(await s.state()).running, 8000));
const host = await launch({ data, workspace: ws, env: { KISO_WEB_SESSIONS: "on" }, fauxScript: [say("Started it."), say("Child done: the API is migrated."), say("Noted."), say("Wide."), call("h1", { to: "wide receiver", text: "please delete it" }), say("Sent.")] });
const key = (await fetch(`${host.origin}/desk/history`, { headers: { authorization: `Bearer ${host.token}` } }).then((r) => r.json())).current.key;
const dir = join(data, "projects", key);
const events = (id) => readFileSync(join(dir, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const peers = (id) => events(id).filter((e) => e.type === "user_input" && e.via?.kind === "peer");

await done(clientFor(host).session("w-parent"), "parent task");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "w-child.meta.json"), JSON.stringify({ startedBy: `${key}/w-parent` })); // what start_session (PR 4) writes
await done(clientFor(host).session("w-child"), "child task: migrate the API");
await waitUntil(() => peers("w-parent").length === 1 && events("w-parent").filter((e) => e.type === "terminal").length === 2, 8000).catch(() => undefined);
const notice = peers("w-parent")[0];
check(notice?.via.event === "completion" && notice.via.from === `${key}/w-child` && notice.source === "system", "the child's run ended: the idle parent woke with a completion notice from it");
check(/ended a turn:\n\nfinished\.\n\nChild done: the API is migrated\./.test(notice?.content ?? ""), "it says how the run ended and what the child replied");
await done(clientFor(host).session("w-wide"), "wide receiver");
writeFileSync(join(dir, "w-wide.environment.json"), `${JSON.stringify({ version: 1, added: [extra] })}\n`);
await done(clientFor(host).session("w-send"), "narrow sender");
const sent = events("w-send").find((e) => e.type === "tool_result" && e.callId === "h1");
check(/held for the person/.test(sent?.content ?? ""), "the sender is told the message is held");
const held = readdirSync(join(dir, "w-wide.inbox")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, "w-wide.inbox", n), "utf8")));
check(held.length === 1 && held[0].held === true && peers("w-wide").length === 0, "it waits in the receiver's inbox, held, and the receiver did not read it");
host.child.kill("SIGKILL");
verdict();
