// Background tasks: a real `sleep 8` outlives its foreground wait and becomes a task, a second is started in the background
// and stopped with task_stop; the tasks frame lists state and elapsed time while the stream stays open.
import { launch, clientFor, scratch, checker, sleep } from "./lib.mjs";

const { check, verdict } = checker("tasks");
const call = (callId, input) => ({ type: "tool_call_end", callId, name: "shell", input });
const host = await launch({ data: scratch("tasks-data"), workspace: scratch("tasks-ws"), env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_MIN_FG_MS: "0" }, fauxScript: [
	{ events: [call("t1", { command: "sleep 8; echo finished", foregroundMs: 1500 }), call("t2", { command: "sleep 60", background: true }), { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Two tasks." }, { type: "stop", reason: "end_turn" }] },
	{ events: [{ type: "tool_call_end", callId: "t3", name: "task_stop", input: { id: "t2" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Stopped." }, { type: "stop", reason: "end_turn" }] },
] });
const s = clientFor(host).session("tasks");
const rows = [];
const outputs = [];
const notices = [];
const ctl = new AbortController();
const reader = (async () => {
	for await (const ev of s.events({ signal: ctl.signal })) {
		if (ev.kind === "frame" && ev.event === "tasks") rows.push(...ev.data.tasks);
		else if (ev.kind === "frame" && ev.event === "tool_output") outputs.push(ev.data);
		else if (ev.kind === "event" && ev.event.type === "user_input" && ev.event.source === "system") notices.push(ev.event);
	}
})();
const idle = async () => { while ((await s.state()).running) await sleep(100); };
await s.run("start two tasks");
await idle();
await sleep(8500);
await s.run("stop the long task");
await idle();
await sleep(1500);
ctl.abort();
await reader;
host.child.kill("SIGTERM");
const t1 = rows.filter((t) => t.id === "t1");
const running = t1.filter((t) => t.label === "running").map((t) => t.elapsedMs);
check(outputs.some((o) => o.callId === "t1" && /continued as background task t1/.test(o.head.join(" "))), "the command that outlived its wait says it became task t1");
check(running.length >= 5 && running.every((v, i) => i === 0 || v >= running[i - 1]), `t1's elapsed time grows while it runs (${running.length} samples)`);
check(t1.some((t) => t.label === "exited 0" && t.elapsedMs >= 7500 && t.elapsedMs <= 9500), "t1 exited 0 after about 8 s, counted from the spawn");
check(rows.some((t) => t.id === "t2" && t.label === "stopped") && outputs.some((o) => /stopped task t2/.test(o.head.join(" "))), "t2 was stopped by task_stop");
check(notices.length === 1 && /<kiso-task id="t1"/.test(notices[0].content), 'the model is told t1 ended through one user_input with source "system"');
verdict();
