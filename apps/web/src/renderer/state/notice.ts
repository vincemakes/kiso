import type { Notice } from "./model.js";

/** The line a runtime notice reads as; a task notice becomes "Task t1 finished", "Task t2 failed" with "exit 2" beside it, "Task t3 stopped". */
export function noticeOf(raw: string): Pick<Notice, "text" | "tone" | "code"> {
	const task = /<kiso-task id="([^"]+)" status="([^"]+)"(?: code="(-?\d+)")?/.exec(raw);
	if (task === null) return { text: raw.replace(/<[^>]*>/g, "").trim().split("\n")[0]!.slice(0, 120), tone: "", code: "" };
	const status = task[2]!;
	return { text: `Task ${task[1]} ${status === "exited" ? "finished" : status}`, tone: status === "failed" ? "fail" : status === "stopped" ? "stop" : "", code: task[3] !== undefined && task[3] !== "0" ? `exit ${task[3]}` : "" };
}
