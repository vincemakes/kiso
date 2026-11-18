// ADR-0038: the "Kiso stopped while this was running" card belongs to the crash window only. A shell call a live run is executing
// is never offered for a verdict: not when the page reads the host again mid-run (a switch away and back), not when a snapshot
// says otherwise (the renderer's own guard), and not while a Stop is cutting it. Sampled every 100 ms, the card never appears.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("uncertain-live");
const ok = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const sleep5 = (callId) => ({ events: [{ type: "tool_call_end", callId, name: "shell", input: { command: "sleep 5" } }, { type: "stop", reason: "tool_use" }] });
const data = scratch("uncertain-live-data");
const app = await launchApp({ data, workspace: scratch("uncertain-live-ws"), env: { KISO_WEB_SESSION: "w", KISO_WEB_MODE: "full-access" }, fauxScript: [ok, sleep5("s1"), ok, sleep5("s2"), ok, sleep5("s3"), ok, ok] });
const q = (js) => app.evaluate(js);
const host = app.host();
const s = clientFor(host).session("w");
const key = (await fetch(`${host.origin}/desk/history`, { headers: { authorization: `Bearer ${host.token}` } }).then((r) => r.json())).current.key;
const log = () => { try { return readFileSync(join(data, "projects", key, "w.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event); } catch { return []; } };
const executing = (id) => log().some((e) => e.type === "tool_execution_started" && e.callId === id) && !log().some((e) => e.type === "tool_result" && e.callId === id);
const idle = async () => (await waitUntil(async () => !(await s.state()).running, 20_000), await sleep(500));
await clientFor(host).session("w-other").run("Another Work."); // the one to switch to
await waitUntil(async () => !(await clientFor(host).session("w-other").state()).running, 10_000);

// the sampler: every 100 ms, is the card on the page
await q(`(() => { window.__verdictSeen = 0; window.__samples = 0; setInterval(() => { window.__samples++; if (document.querySelector('[data-kind="verdicts"]')) window.__verdictSeen++; }, 100); return true; })()`);
const switchAndBack = async () => {
	await q(`window.__kisoOpenWork({ key: ${JSON.stringify(key)}, sessionId: "w-other" })`);
	await sleep(700);
	await q(`window.__kisoOpenWork({ key: ${JSON.stringify(key)}, sessionId: "w" })`);
	await sleep(1200);
};

// 1. a switch away and back while sleep 5 runs: the page reads the host again; the host says no uncertain
await q(`window.__kiso.send("Wait a bit.")`);
await waitUntil(() => executing("s1"), 10_000);
const mid = await s.state();
check(mid.running && mid.uncertain.length === 0, `mid-run, the host's snapshot is running with no uncertain (${JSON.stringify(mid.uncertain)})`);
await switchAndBack();
check(executing("s1"), "the switch and back happened while the call was still executing");
await idle();

// 2. the same with a snapshot that claims one (as the host did before the fix): the renderer's own guard keeps the card away
await q(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o); if ((o?.method ?? "GET") !== "GET" || !/\\/(state|replay)(\\?|$)/.test(String(u))) return r; const body = await r.clone().json(); const st = body.state ?? body; if (st.running) st.uncertain = [{ executionId: "ex-forged", callId: "s2", name: "shell" }]; return new Response(JSON.stringify(body), { status: r.status, headers: r.headers }); }; return true; })()`);
await q(`window.__kiso.send("Wait again.")`);
await waitUntil(() => executing("s2"), 10_000);
await switchAndBack();
check(executing("s2"), "the forged snapshots were read while the call was still executing");
await idle();

// 3. Stop while sleep 5 runs (the snapshots still forged while running): the card never flashes
await q(`window.__kiso.send("Wait once more.")`);
await waitUntil(() => executing("s3"), 10_000);
await sleep(300);
await q(`window.__kiso.abort().then(() => true)`);
await idle();
check(log().some((e) => e.type === "terminal" && e.outcome?.kind === "aborted"), "the Stop ended the run (aborted)");

const seen = await q(`window.__verdictSeen`);
const samples = await q(`window.__samples`);
check(samples > 100 && seen === 0, `the card never appeared: ${seen} of ${samples} samples, 100 ms apart`);
await app.close();
verdict();
