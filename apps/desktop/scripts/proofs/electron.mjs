// The Electron main starts the host (in a utility process, or in the main
// process with `main` as the argument), loads the renderer, and the page
// streams a run through kiso-client. Seen through the remote debugging port:
// the page's own DOM.
import { scratch, transcript, checker, launchElectron, waitUntil } from "./lib.mjs";

const where = process.argv[2] === "main" ? "main" : "utility";
const out = transcript(where === "main" ? "electron-host-in-main" : "electron");
const { check, verdict } = checker(out);
const script = [
	{ events: [{ type: "thinking", text: "Plan: look at the folder." }, { type: "text_delta", text: "Looking." }, { type: "tool_call_end", callId: "e1", name: "list_dir", input: {} }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "The workspace is **empty**." }, { type: "usage", inputTokens: 1000, outputTokens: 20, cacheRead: 800, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] },
];
const app = await launchElectron({
	data: scratch("electron-data"),
	workspace: scratch("electron-ws"),
	fauxScript: script,
	env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_AUTORUN: "what is in the workspace?", ...(where === "main" ? { KISO_DESKTOP_HOST_IN_MAIN: "1" } : {}) },
});
out(`READY electron ${app.ready.electron}, host in the ${app.ready.hosting} process (${app.startupMs} ms)`);
check(app.ready.hosting === where, `the host runs in the ${where} process`);
if (where === "utility") check(app.ready.hostPid !== app.ready.pid, `the host is another process (host ${app.ready.hostPid}, main ${app.ready.pid})`);
const dom = (q) => app.evaluate(`document.querySelector(${JSON.stringify(q)})?.textContent ?? null`);
check(await waitUntil(async () => (await dom("[data-kind=footer]")) !== null), "the page drew a whole run, up to its footer");
check((await dom("[data-kind=me]")) === "what is in the workspace?", "the person's line");
check((await dom("[data-kind=answer]")) === "The workspace is empty.", `the answer, markdown drawn: ${await dom("[data-kind=answer]")}`);
check((await app.evaluate("document.querySelector('[data-kind=answer] b')?.textContent")) === "empty", "bold is an element, not asterisks");
check((await app.evaluate("document.querySelector('[data-kind=process]').dataset.folded")) === "true", "the process is folded after the run");
check(/in · .* out · \d+% cache/.test(await dom("[data-kind=footer]")), `the footer: ${await dom("[data-kind=footer]")}`);
check(!(await app.evaluate("location.href")).includes("token="), "the token is no longer in the page address");
check(app.lines.some((l) => l.startsWith("READY")), "the main process reported READY");
await app.close();
verdict(where === "main" ? "electron (host in main)" : "electron (host in utility process)");
