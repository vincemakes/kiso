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
const seen = async () => JSON.parse(await app.evaluate("JSON.stringify(window.__kiso.events.map(e => e.seq))"));
check(await waitUntil(async () => (await seen()).length >= 2), "the run is streaming into the page (user line and first text)");
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
check(await waitUntil(async () => (await app.evaluate("window.__kiso.done")) === true, 20_000), "after resume the page sees the terminal");
const seqs = await seen();
const durable = (await s.replay()).events.map((e) => e.seq);
const types = JSON.parse(await app.evaluate("JSON.stringify(window.__kiso.events.map(e => e.type))"));
out(`page seqs ${JSON.stringify(seqs)}; durable ${JSON.stringify(durable)}; types ${types.join(" ")}`);
check(JSON.stringify(seqs) === JSON.stringify(durable), "the page has every durable wire event exactly once, in order (no duplicate, no gap)");
check(types.includes("draft_voided") && types.at(-1) === "terminal", "the half-written draft is voided and the run completes");
await app.close();
verdict("host-process");
