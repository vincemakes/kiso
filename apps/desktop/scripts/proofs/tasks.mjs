// Line 5: background tasks. A real `sleep 8` outlives its foreground wait
// and becomes a task; a second is started with background:true and stopped
// with task_stop. The tasks frame (host-made, from the TaskManager) lists
// state and elapsed time; the stream stays open after the run ended.
import { launch, clientFor, scratch, transcript, sleep, checker } from "./lib.mjs";

const out = transcript("s5-tasks");
const data = scratch("s5-data");
const workspace = scratch("s5-ws");
const script = [
	{ events: [{ type: "tool_call_end", callId: "t1", name: "shell", input: { command: "sleep 8; echo finished-foreground-task", foregroundMs: 1500 } }, { type: "tool_call_end", callId: "t2", name: "shell", input: { command: "sleep 60", background: true } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Two tasks are running." }, { type: "stop", reason: "end_turn" }] },
	// run 2, later: stop the long one; the model hears of the first one's end
	{ events: [{ type: "tool_call_end", callId: "t3", name: "task_stop", input: { id: "t2" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Stopped." }, { type: "stop", reason: "end_turn" }] },
];
const host = await launch({ data, workspace, fauxScript: script, env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_MIN_FG_MS: "0" } });
out(`host ${host.origin}`);
const s = clientFor(host).session("s5");
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6);
const ctl = new AbortController();
let lastTasks = "";
const taskFrames = [];
const notices = [];
const outputs = [];
const reader = (async () => {
	for await (const ev of s.events({ signal: ctl.signal })) {
		if (ev.kind === "frame" && ev.event === "tool_output") outputs.push(ev.data);
		if (ev.kind === "event" && ev.event.type === "user_input" && ev.event.source === "system") notices.push(ev.event);
		if (ev.kind === "frame" && ev.event === "tasks") {
			taskFrames.push(ev.data);
			// print only when a state changed, plus a sample of the elapsed counter
			const rows = ev.data.tasks.map((t) => `${t.id}:${t.label}:${Math.round(t.elapsedMs / 100) / 10}s`).join("  ");
			const key = ev.data.tasks.map((t) => `${t.id}:${t.label}`).join();
			if (key !== lastTasks || ev.data.tasks.some((t) => t.endedAt === null)) out(`${stamp()}ms FRAME tasks [${rows}]`);
			lastTasks = key;
		} else if (ev.kind === "frame") out(`${stamp()}ms FRAME ${ev.event} ${JSON.stringify(ev.data).slice(0, 300)}`);
		else if (ev.kind === "event") {
			const { seq, type, ...rest } = ev.event;
			// a task notice arrives as a user_input whose source says it is not the person
			if (type === "user_input") out(`${stamp()}ms ${String(seq).padStart(3)} user_input source=${rest.source ?? "(none)"} ${JSON.stringify(rest.content).slice(0, 90)}`);
			else if (!["tool_execution_started", "tool_execution_succeeded"].includes(type)) out(`${stamp()}ms ${String(seq).padStart(3)} ${type} ${JSON.stringify(rest)}`.slice(0, 260));
		}
	}
})();
const idle = async () => {
	for (;;) {
		if (!(await s.state()).running) return;
		await sleep(100);
	}
};
await s.run("start two tasks");
await idle();
out(`${stamp()}ms run 1 ended; waiting for the 8 s task to finish`);
await sleep(8500);
await s.run("stop the long task");
await idle();
await sleep(1500);
ctl.abort();
await reader;
out("--- journal files the host read these from (a host that cannot import the manager could read the same):");
const { execSync } = await import("node:child_process");
out(execSync(`ls ${data}/sessions/s5.tasks/*; echo; cat ${data}/sessions/s5.tasks/t1/journal.jsonl | cut -c1-200`).toString());
host.child.kill("SIGTERM");

const { check, verdict } = checker(out);
const at = (id, label) => taskFrames.some((f) => f.tasks.some((t) => t.id === id && t.label === label));
check(outputs.some((o) => o.callId === "t1" && /continued as background task t1/.test(o.head.join(" "))), "the foreground command that outlived its wait says it became task t1 (tool_output frame)");
check(at("t1", "running") && at("t2", "running"), "tasks frame: t1 and t2 running");
const t1 = taskFrames.flatMap((f) => f.tasks).filter((t) => t.id === "t1");
check(t1.some((t) => t.label === "exited 0" && t.elapsedMs >= 7500 && t.elapsedMs <= 9500), "tasks frame: t1 exited 0 after about 8 s (counted from the spawn)");
const running = t1.filter((t) => t.label === "running").map((t) => t.elapsedMs);
check(running.length >= 5 && running.every((v, i) => i === 0 || v >= running[i - 1]), `tasks frame: t1's elapsed time grows while running (${running.length} samples)`);
check(at("t2", "stopped"), "tasks frame: t2 stopped after task_stop");
check(outputs.some((o) => o.callId === "t3" && /stopped task t2/.test(o.head.join(" "))), "task_stop reports the stop");
check(notices.length === 1 && /<kiso-task id="t1"/.test(notices[0].content), 'the model is told t1 ended through one user_input with source "system"');
verdict("tasks");
