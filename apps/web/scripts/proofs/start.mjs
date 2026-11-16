// ADR-0062 PR 4: start_session. "asked" starts a Work at once, linked to its parent, its first line the brief; "named" draws a
// card the person answers (Start makes the Work, × dismisses, Do it here sends the parent a line); a fork waits for the
// parent's turn to end and starts from its conversation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("start");
const okay = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const start = (callId, input) => ({ events: [{ type: "tool_call_end", callId, name: "start_session", input }, { type: "stop", reason: "tool_use" }] });
const data = scratch("start-data");
const ws = scratch("start-ws");
const brief = "Fix the CSV export of invoices. Deliverable: a passing test.";
const script = [start("s1", { title: "Fix the export", brief, initiation: "asked" }), ...Array(3).fill(okay), start("s2", { title: "Card work", brief: "Card brief.", initiation: "named" }), start("s3", { title: "Not now", brief: "x", initiation: "proposed" }), ...Array(3).fill(okay), start("s4", { title: "Forked", brief: "Fork brief.", initiation: "asked", context: "fork" }), ...Array(6).fill(okay)];
const host = await launch({ data, workspace: ws, env: { KISO_WEB_SESSIONS: "on" }, fauxScript: script });
const auth = { authorization: `Bearer ${host.token}` };
const desk = (path, body) => fetch(`${host.origin}${path}`, body === undefined ? { headers: auth } : { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const key = (await desk("/desk/history")).body.current.key;
const dir = join(data, "projects", key);
// a Work just started may not have written its first line yet: a missing or empty log reads as no events
const events = (id) => { try { return readFileSync(join(dir, `${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).event); } catch { return []; } };
const firstLine = async (id) => (await waitUntil(() => events(id).some((e) => e.type === "user_input"), 8000), events(id).find((e) => e.type === "user_input"));
const env = async (id) => (await desk(`/desk/env?key=${key}&session=${id}`)).body;
const done = async (s, text) => (await s.run(text), await waitUntil(async () => !(await s.state()).running, 8000));
const childOf = async (parent) => (await desk("/desk/history?fresh=" + key)).body.works.find((w) => w.parent === parent);

await done(clientFor(host).session("w-a"), "put the export fix in a session of its own");
await waitUntil(async () => (await childOf("w-a")) !== undefined, 8000);
const child = await childOf("w-a");
const first = await firstLine(child.id);
check(child.title === "Fix the export" && first.content === brief && first.source !== "system", "asked: the Work starts at once, named by its title, its first line the brief verbatim");
check((await env(child.id)).started?.parent === "w-a" && (await env("w-a")).cards.s1.state === "started" && (await env("w-a")).cards.s1.work === child.id, "it is linked to its parent (nested under it, 'Started from'), and the parent's card records it");
await new Promise((r) => setTimeout(r, 1500)); // the child's report back to w-a, and w-a's wake, take their requests first
await done(clientFor(host).session("w-b"), "also the invoice export");
check((await env("w-b")).cards.s2.state === "pending" && (await env("w-b")).cards.s3.state === "pending", "named and proposed: cards, nothing started");
const started = await desk("/desk/session-card", { session: "w-b", callId: "s2", action: "start" });
check(started.status === 200 && (await firstLine(started.body.id)).content === "Card brief.", "Start makes the Work from the card's brief");
check((await desk("/desk/session-card", { session: "w-b", callId: "s2", action: "start" })).status === 409, "a card answered once cannot start a second Work");
await desk("/desk/session-card", { session: "w-b", callId: "s3", action: "dismiss" });
check((await env("w-b")).cards.s3.state === "dismissed", "× dismisses it");
await new Promise((r) => setTimeout(r, 1500));
await done(clientFor(host).session("w-c"), "fork this into its own Work");
await waitUntil(async () => (await childOf("w-c")) !== undefined, 8000);
const forkId = (await childOf("w-c")).id;
await waitUntil(() => events(forkId).filter((e) => e.type === "user_input").length >= 2, 8000);
const forked = events(forkId).filter((e) => e.type === "user_input").map((e) => (typeof e.content === "string" ? e.content : e.content.map((b) => b.text ?? "").join("\n"))); // a fork's first line carries the fork note too
check(forked[0] === "fork this into its own Work" && forked.at(-1).endsWith("Fork brief."), "a fork starts after the parent's turn ends, from its conversation, with the brief as its next line");
host.child.kill("SIGKILL");
verdict();
