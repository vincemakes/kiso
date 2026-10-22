// The Electron main starts the host (utility process, or the main process with `main`), loads the renderer,
// and the page draws a whole run through kiso-client.
import { execFileSync } from "node:child_process";
import { scratch, checker, launchElectron, waitUntil } from "./lib.mjs";

const where = process.argv[2] === "main" ? "main" : "utility";
const { check, verdict } = checker(`electron (host in ${where})`);
const script = [
	{ events: [{ type: "thinking", text: "Plan: look at the folder." }, { type: "text_delta", text: "Looking." }, { type: "tool_call_end", callId: "e1", name: "list_dir", input: {} }, { type: "tool_call_end", callId: "e2", name: "shell", input: { command: "sleep 4; echo bg-done", background: true } }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "The workspace is **empty**." }, { type: "usage", inputTokens: 1000, outputTokens: 20, cacheRead: 800, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] },
];
const app = await launchElectron({ data: scratch("el-data"), workspace: scratch("el-ws"), fauxScript: script, env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_AUTORUN: "what is in the workspace?", ...(where === "main" && { KISO_DESKTOP_HOST_IN_MAIN: "1" }) } });
check(app.ready.hosting === where && (where === "main" || app.ready.hostPid !== app.ready.pid), `the host runs in the ${where} process`);
// the pids of every application named "Electron" in the Dock's registry (lsappinfo prints one block per application)
const dock = () => execFileSync("lsappinfo", ["list"], { encoding: "utf8" }).split(/^\d+\) /m).filter((b) => b.startsWith('"Electron"')).map((b) => Number(/pid = (\d+)/.exec(b)?.[1]));
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null), "the page drew a whole run, up to its footer");
// a `background: true` command is started in the task runner, which must be a plain node process: it must not appear as an application (the Dock)
check((await app.count(".step[data-tool=shell] .bgtag")) === 1 && !(await app.text(".step[data-tool=shell]")).includes("did not record"), "a background: true command started its task runner under Electron");
check(dock().every((pid) => pid === app.ready.pid), `while the task runs the only Electron application is the app itself (pids ${dock()}, app ${app.ready.pid})`);
check(await waitUntil(async () => /t1 · exited 0/.test((await app.text(".step[data-tool=shell] .s-req")) ?? ""), 10_000), "the task ended exited 0");
check((await app.text("[data-kind=me]")) === "what is in the workspace?" && (await app.text("[data-kind=answer]")) === "The workspace is empty.", "the person's line and the answer");
check((await app.text("[data-kind=answer] b")) === "empty", "bold is an element, not asterisks");
check((await app.evaluate("document.querySelector('[data-kind=process]').dataset.folded")) === "true", "the process is folded after the run");
check(/in · .* out · \d+% cache/.test(await app.text("[data-kind=footer]")), "the footer");
check(!(await app.evaluate("location.href")).includes("token="), "the token is not left in the page address");
await app.close();
verdict();
