// ADR-0062 § 7 with a delete in flight: a child's notice for a parent deleted while the notice was being made (the history scan
// awaited between the first look and the write) writes nothing and delivers nothing: no inbox or meta of the parent comes back.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { notifyParent } from "../../dist/main/message-tool.js";
import { checker } from "./lib.mjs";

const { check, verdict } = checker("notify-deleted");
const root = mkdtempSync(join(tmpdir(), "kiso-nd-"));
const store = new SessionStore(root);
const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "Done." }, { type: "stop", reason: "end_turn" }] }]) });
const child = await agent.session({ id: "c" });
for await (const _ of child.run("go")) void _;
const meta = join(root, "c.meta.json"); // the child was started by k/p (the meta's startedBy, as the delete-tree proof writes it)
writeFileSync(meta, JSON.stringify({ ...(existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")) : {}), startedBy: "k/p" }));
const parentMeta = join(root, "p.meta.json");
const runId = store.load("c").at(-1).runId;
let delivered = 0;
// the host: its scan is where the delete lands (as the desk's delete route would, in the same process, between the awaits)
const host = (deleteDuringScan) => ({
	dirOf: () => root,
	list: async () => (deleteDuringScan && rmSync(parentMeta, { force: true }), { works: [] }),
	deliver: async () => void delivered++,
});

writeFileSync(parentMeta, "{}");
await notifyParent(store, "k", "c", runId, false, host(false));
check(existsSync(join(root, "p.inbox")) && delivered === 1, "a live parent gets the notice and is delivered to (the control)");
rmSync(join(root, "p.inbox"), { recursive: true, force: true });

writeFileSync(parentMeta, "{}");
delivered = 0;
await notifyParent(store, "k", "c", runId, false, host(true));
check(!existsSync(join(root, "p.inbox")) && !existsSync(parentMeta) && delivered === 0, `deleted during the scan: no inbox made, nothing delivered (inbox ${existsSync(join(root, "p.inbox"))}, delivered ${delivered})`);
verdict();
