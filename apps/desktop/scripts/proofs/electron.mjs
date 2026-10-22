// The Electron main starts the host (in a utility process, or in the main
// process with `main` as the argument), loads the renderer page, and the page
// streams a run through kiso-client. Seen two ways: the page's console,
// forwarded to stdout by the main, and the remote debugging port, where this
// script reads the page's own state.
import { scratch, transcript, checker, launchElectron, waitUntil } from "./lib.mjs";

const where = process.argv[2] === "main" ? "main" : "utility";
const out = transcript(where === "main" ? "electron-host-in-main" : "electron");
const { check, verdict } = checker(out);
const think = (text) => ({ type: "thinking", text });
const script = [
	{ events: [think("Plan: read the file."), think(" Then answer.\n\n"), think("Second paragraph of the plan."), { type: "text_delta", text: "Looking." }, { type: "tool_call_end", callId: "e1", name: "list_dir", input: {} }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "The workspace is empty." }, { type: "usage", inputTokens: 1000, outputTokens: 20, cacheRead: 800, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] },
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
const done = await waitUntil(async () => (await app.evaluate("window.__kiso?.done")) === true);
const state = JSON.parse(await app.evaluate("JSON.stringify({ types: window.__kiso.events.map(e => e.type), frames: window.__kiso.frames.map(f => f.event), href: location.href })"));
out(`page state: ${JSON.stringify(state)}`);
check(done && state.types.includes("terminal"), "the renderer received a whole streamed run");
check(["thinking", "tool_call_end", "tool_result", "text_delta"].every((t) => state.types.includes(t)), "thinking, a tool call, its result and text all reached the page");
check(["at", "usage", "tool_output", "run_usage"].every((f) => state.frames.includes(f)), "the host frames reached the page (at, usage, tool_output, run_usage)");
check(!state.href.includes("token="), "the token is no longer in the page address");
check(app.lines.some((l) => l.startsWith("RENDERER ")), "the page console is forwarded to stdout");
await app.close();
verdict(where === "main" ? "electron (host in main)" : "electron (host in utility process)");
