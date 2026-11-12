import type { Notice } from "./model.js";

/** The line a runtime notice reads as; a task notice names the task by its title, found on this Work's own steps: "‹title› finished",
 *  "‹title› failed" with "exit 2" beside it, "‹title› stopped"; an id this Work does not know reads "A background task finished". */
export function noticeOf(raw: string, titleOf: (id: string) => string | null = () => null): Pick<Notice, "text" | "tone" | "code"> {
	const task = /<kiso-task id="([^"]+)" status="([^"]+)"(?: code="(-?\d+)")?/.exec(raw);
	if (task === null) return { text: raw.replace(/<[^>]*>/g, "").trim().split("\n")[0]!.slice(0, 120), tone: "", code: "" };
	const [status, exit] = [task[2]!, task[3]];
	const failed = status === "failed" || (status === "exited" && exit !== undefined && exit !== "0");
	const what = failed ? "failed" : status === "stopped" ? "stopped" : "finished";
	return { text: `${titleOf(task[1]!) ?? "A background task"} ${what}`, tone: failed ? "fail" : status === "stopped" ? "stop" : "", code: exit !== undefined && exit !== "0" ? `exit ${exit}` : "" };
}
