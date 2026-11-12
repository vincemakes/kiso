// A Work's title is decided from the log and the name file, not from memory: with no page watching, a title that failed while the first
// run was live is asked again when the run settles; and a Work that stayed unnamed (every ask failed) is asked again, once, when it is
// opened after the host restarted.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checker, clientFor, launch, scratch, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("title-durable");
const FAIL = { events: [{ type: "fail", code: "timeout", retryable: false, message: "Request timed out." }] };
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const [data, workspace] = [scratch("td-data"), scratch("td-ws")];
const env = { KISO_AUTO_TITLE: "on" };
const nameOf = (id) => { try { return JSON.parse(readFileSync(join(data, "projects", readdirSync(join(data, "projects"))[0], `${id}.meta.json`), "utf8")).name ?? null; } catch { return null; } };
const h1 = await launch({ data, workspace, fauxScript: [FAIL, FAIL, say("Named with no page"), FAIL, FAIL, FAIL], env });
await clientFor(h1).session("t1").run("first Work: fix the ledger");
check(await waitUntil(async () => nameOf("t1") === "Named with no page", 15_000), "no page is watching: a title that failed during the first run is asked again when the run settles");
await clientFor(h1).session("t2").run("second Work: every ask fails");
await waitUntil(async () => !(await clientFor(h1).session("t2").state()).running);
await new Promise((r) => setTimeout(r, 1500));
check(nameOf("t2") === null, "a Work whose asks all failed stays unnamed (two asks at most in a host's life)");
process.kill(h1.pid, "SIGKILL");
await new Promise((r) => (h1.child.exitCode !== null ? r() : h1.child.once("exit", r)));
const h2 = await launch({ data, workspace, fauxScript: [say("Named after a restart")], env });
await clientFor(h2).session("t2").state();
check(await waitUntil(async () => nameOf("t2") === "Named after a restart", 15_000), "the host restarted: opening the still-unnamed Work asks for its title again");
h2.child.kill("SIGTERM");
verdict();
process.exit(process.exitCode ?? 0);
