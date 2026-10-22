// A host crash does not take the window with it. The host runs in an
// Electron utility process; this proof kills it with SIGKILL (by its own
// pid) in the middle of a run. The main process and the page must stay up,
// the main process starts another host on the same port and token, the
// page's one long-lived stream reconnects, and after a resume the page has
// every event exactly once.
import { createClient } from "@vincemakes/kiso-client";
import { scratch, transcript, checker, launchElectron, waitUntil } from "./lib.mjs";

const out = transcript("host-process");
const { check, verdict } = checker(out);
const script = [{ events: [{ type: "text_delta", text: "part one, " }, { type: "delay", ms: 6000 }, { type: "text_delta", text: "part two" }, { type: "stop", reason: "end_turn" }] }];
const app = await launchElectron({
	data: scratch("hostproc-data"),
	workspace: scratch("hostproc-ws"),
	fauxScript: script,
	env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_AUTORUN: "go", KISO_DESKTOP_SESSION: "hostproc", KISO_DESKTOP_FAUX_SKIP: "hostproc" },
});
const { hostPid, pid: mainPid, token, port } = app.ready;
out(`electron main ${mainPid}, host (utility process) ${hostPid}, port ${port}`);
await app.evaluate("window.__marker = 'same page'");
const dom = (q) => app.evaluate(`document.querySelector(${JSON.stringify(q)})?.textContent ?? null`);
const count = (q) => app.evaluate(`document.querySelectorAll(${JSON.stringify(q)}).length`);
check(await waitUntil(async () => (await dom("[data-kind=answer]")) === "part one,"), "the run is streaming into the page (first text on screen)");
out(`KILL -9 host ${hostPid}`);
process.kill(hostPid, "SIGKILL");
check(await waitUntil(() => app.lines.some((l) => l.startsWith("HOST_EXIT"))), "the main process noticed the host exit");
let alive = true;
try {
	process.kill(mainPid, 0);
} catch {
	alive = false;
}
check(alive, "the Electron main process is still alive");
check((await app.evaluate("window.__marker")) === "same page", "the page was not reloaded and still answers");
check(await waitUntil(() => app.lines.some((l) => l.startsWith("HOST_RESPAWNED"))), "the main process started another host");
const respawned = JSON.parse(app.lines.find((l) => l.startsWith("HOST_RESPAWNED")).slice("HOST_RESPAWNED ".length));
check(respawned.pid !== hostPid, `a new host process (${respawned.pid})`);

// the person's side: the open run is reported, and resuming it finishes it
const s = createClient({ baseUrl: `http://127.0.0.1:${port}/v1/sessions`, headers: () => ({ authorization: `Bearer ${token}` }) }).session("hostproc");
const state = await s.state();
check(state.openRun !== null && state.running === false, "the restarted host reports an open run (nothing runs by itself)");
out(`resume => ${JSON.stringify(await s.resume())}`);
check(await waitUntil(async () => (await dom("[data-kind=footer]")) !== null, 20_000), "after resume the page finishes the run (footer)");
const durable = (await s.replay()).events.map((e) => e.type);
out(`durable wire types: ${durable.join(" ")}`);
check((await dom("[data-kind=answer]")) === "part one, part two", `the page shows the voided draft replaced, once: ${await dom("[data-kind=answer]")}`);
check((await count("[data-kind=me]")) === 1 && (await count("[data-kind=answer]")) === 1, "one turn, one answer: nothing duplicated after the reconnect");
check(durable.includes("draft_voided"), "the half-written draft was voided in the log");
await app.close();
verdict("host-process");
