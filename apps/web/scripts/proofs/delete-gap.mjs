// A Work deleted while its store close is still pending (#520 made the delete `await store.close()` and then remove the files): a
// child's completion notice that lands in that gap is never written, and after the delete no writer can make the Work's inbox again.
// No host, no model: the real workAct and notifyParent over a real store, the close held open by hand.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { InboxRefusedError, writeMessage, writeSessionName, writeStartedBy } from "@vincemakes/kiso-runtime/internal";
import { checker } from "./lib.mjs";
import { workAct } from "../../dist/main/works.js";
import { notifyParent } from "../../dist/main/message-tool.js";

const { check, verdict } = checker("delete-gap");
const dir = mkdtempSync(join(tmpdir(), "kiso-delete-gap-"));
const key = "k";
const store = new SessionStore(dir);
const run = async (id, runId) => {
	let seq = store.load(id).length;
	await store.append(id, runId, { seq: seq++, type: "user_input", content: "go", source: "user" });
	await store.append(id, runId, { seq: seq++, type: "text_delta", text: "done" });
	await store.append(id, runId, { seq: seq++, type: "stop", reason: "end_turn" });
	await store.append(id, runId, { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
};
await run("wp", "r0");
writeSessionName(dir, "wp", "Parent");
await run("wa", "r1");
writeSessionName(dir, "wa", "Child");
writeStartedBy(dir, "wa", `${key}/wp`);

// the delete, with its store close held open: the gap #520 opened
let open;
const gate = new Promise((r) => (open = r));
const space = { key, dir, store: { ids: () => store.ids(), close: async (id) => (await gate, store.close(id)) }, tasks: { managerFor: () => ({ list: () => [] }), forget: () => undefined }, service: { isRunning: () => false } };
const settings = { bury: () => undefined, forget: () => undefined, mark: () => undefined };
const deleting = workAct(space, settings, "wp", "delete");
await new Promise((r) => setImmediate(r));

// the child's run ends in the gap: its completion notice must see the parent as gone
const host = { dirOf: () => dir, list: async () => ({ works: [{ key, id: "wa", title: "Child" }] }), deliver: async () => "now" };
await notifyParent(store, key, "wa", "r1", false, host);
const inGap = existsSync(join(dir, "wp.inbox"));
open();
await deleting;
const left = readdirSync(dir).filter((f) => f.startsWith("wp."));
check(!inGap && left.length === 0, `a completion notice in the close gap writes nothing, and the delete leaves nothing of the parent (in the gap: ${inGap ? "wp.inbox made" : "nothing"}; after: ${left.join(",") || "nothing"})`);

// after the delete, any writer (the message tool's included) is refused in words, and makes no inbox
let refused = null;
try {
	// the message tool's write, with the host's word on the receiver (its sidecar), as message-tool.ts passes it
	await writeMessage(dir, "wp", { messageId: "m1", from: `${key}/wa`, fromTitle: "Child", text: "late", files: [], rootId: `${key}/wa#0`, at: Date.now() }, () => existsSync(join(dir, "wp.meta.json")));
} catch (e) {
	refused = e;
}
check(refused instanceof InboxRefusedError && /no longer exists/.test(refused.message) && !existsSync(join(dir, "wp.inbox")), `a write to the deleted Work is an explicit refusal and makes no inbox (${refused?.message ?? "it was written"})`);
await store.closeAll();
verdict();
