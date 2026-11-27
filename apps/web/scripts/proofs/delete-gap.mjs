// A Work deleted while its store close is still pending (#520 made the delete `await store.close()` and then remove the files): a
// child's completion notice that lands in that gap is never written, and a message whose receiver is deleted while it is being sent
// is refused in words and makes no inbox. No host, no model: the real workAct, notifyParent and message tool over a real store.
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { checker } from "./lib.mjs";
import { sweepBuried, workAct } from "../../dist/main/works.js";
import { Settings } from "../../dist/main/settings.js";
import { messageTool, notifyParent } from "../../dist/main/message-tool.js";

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
// the sidecars as the host writes them: a name, and the child's parent
const sidecar = (id, tenants) => writeFileSync(join(dir, `${id}.meta.json`), `${JSON.stringify(tenants, null, "\t")}\n`);
await run("wp", "r0");
sidecar("wp", { name: "Parent" });
await run("wa", "r1");
sidecar("wa", { name: "Child", startedBy: `${key}/wp` });

// 1. the delete, with its store close held open (the gap #520 opened); the child's run ends in the gap
let open;
const gate = new Promise((r) => (open = r));
const space = { key, dir, store: { ids: () => store.ids(), close: async (id) => (await gate, store.close(id)) }, tasks: { managerFor: () => ({ list: () => [] }), forget: () => undefined }, service: { isRunning: () => false } };
const settings = { bury: () => undefined, forget: () => undefined, mark: () => undefined };
const deleting = workAct(space, settings, "wp", "delete");
await new Promise((r) => setImmediate(r));
const rows = [{ key, id: "wa", title: "Child", folder: "f" }, { key, id: "wp", title: "Parent", folder: "f" }];
const host = { dirOf: () => dir, list: async () => ({ works: rows }), deliver: async () => "now" };
await notifyParent(store, key, "wa", "r1", false, host);
const inGap = existsSync(join(dir, "wp.inbox"));
open();
await deleting;
const left = readdirSync(dir).filter((f) => f.startsWith("wp."));
check(!inGap && left.length === 0, `a completion notice in the close gap writes nothing, and the delete leaves nothing of the parent (in the gap: ${inGap ? "wp.inbox made" : "nothing"}; after: ${left.join(",") || "nothing"})`);

// 2. the message tool: the receiver is listed and still there at its first look, then deleted while the tool checks the file it sends
//    (the sidecar goes, as workAct's first step removes it); the write that follows is refused in words and makes no inbox
await run("wq", "r2");
sidecar("wq", { name: "Receiver" });
const file = join(dir, "note.txt");
writeFileSync(file, "x\n");
const tool = messageTool({ key, sessionId: "wa" }, {
	...host,
	list: async () => ({ works: [...rows, { key, id: "wq", title: "Receiver", folder: "f" }] }),
	cwdOf: () => dir,
	mayRead: () => (rmSync(join(dir, "wq.meta.json"), { force: true }), true),
	eventsOf: () => [],
	tierOf: () => "default",
	chainOf: () => `${key}/wa#0`,
});
const sent = await tool.execute({ to: `${key}/wq`, text: "late", files: [file] }, { callId: "c1" });
check(sent.isError === true && /no longer exists/.test(String(sent.content)) && !existsSync(join(dir, "wq.inbox")), `a message whose receiver is deleted while it is sent is refused in words, and no inbox is made (${String(sent.content).slice(0, 80)})`);
// 3. #21/#28: a delete cut short after the log went (a kill mid-loop, here a throw) leaves the rest; the next open's sweep finishes it,
//    forgets the Work, does it once, and never touches a buried id whose sidecar exists again or a Work that was never deleted
const real = new Settings(mkdtempSync(join(tmpdir(), "kiso-delete-gap-home-")), null, "default");
for (const id of ["wk", "wm", "wo", "wn"]) (await run(id, `r-${id}`), sidecar(id, { name: id }), mkdirSync(join(dir, `${id}.inbox`)));
const age = (id, s) => utimesSync(join(dir, `${id}.meta.json`), Date.now() / 1000 + s, Date.now() / 1000 + s);
real.mark("wk", "pins", true);
const rm = fs.rmSync;
fs.rmSync = (p, o) => { if (String(p).endsWith("wk.lock")) throw Object.assign(new Error("killed"), { code: "EKILLED" }); return rm(p, o); };
syncBuiltinESMExports();
const cut = await workAct({ ...space, store }, real, "wk", "delete").then(() => "finished", (e) => e.code);
fs.rmSync = rm;
syncBuiltinESMExports();
const half = readdirSync(dir).filter((f) => f.startsWith("wk.")).sort();
// wo: killed between the tombstone and its sidecar's removal (the sidecar is older): finished. wm: its sidecar written again after the
// delete: left alone. wn: a tombstone with no time (before 0.56.3) and a sidecar: left alone
(age("wo", -60), real.bury(key, "wo"), real.bury(key, "wm"), age("wm", 5), real.write({ deleted: [...real.buriedIn(key).map((b) => `${key}/${b.session}`), `${key}/wn`] }));
const swept = sweepBuried(dir, key, real).sort(), again = sweepBuried(dir, key, real), gone = (id) => !readdirSync(dir).some((f) => f.startsWith(`${id}.`));
check(cut === "EKILLED" && !half.includes("wk.jsonl") && half.includes("wk.inbox") && swept.join() === "wk,wo" && again.length === 0 && gone("wk") && gone("wo") && !real.remembers("wk") && ["wm", "wn", "wa"].every((id) => existsSync(join(dir, `${id}.jsonl`)) && existsSync(join(dir, `${id}.meta.json`))), `a delete cut short is finished by the startup sweep, once, a sidecar older than the delete with it; a sidecar written since, a tombstone with no time and a live Work are left alone (cut: ${cut}; left: ${half}; swept: ${swept}; again: ${again})`);
await store.closeAll();
verdict();
