import { execFile, type ExecFileException } from "node:child_process";
import { Refusal } from "./files.js";

/**
 * The system's own folder picker, shown on the machine the host runs on (the host listens on this computer only, so that is the
 * person's screen): macOS `osascript`, Linux `zenity`. The page asks and waits; a path comes back, or null when the person cancels.
 * Elsewhere, or when the program is missing, it answers 501 and the page falls back to its own folder browser. The host judges the
 * path again when it is opened, as for a typed one. KISO_WEB_PICKER names another program to run instead (the proofs): it prints
 * the path and exits 0, or exits 1 for a cancel.
 */
function command(): { readonly cmd: string; readonly args: readonly string[] } | null {
	const custom = process.env["KISO_WEB_PICKER"];
	if (custom !== undefined && custom !== "") return { cmd: custom, args: [] };
	if (process.platform === "darwin") return { cmd: "osascript", args: ["-e", "tell me to activate", "-e", 'POSIX path of (choose folder with prompt "Choose a folder")'] };
	if (process.platform === "linux") return { cmd: "zenity", args: ["--file-selection", "--directory", "--title=Choose a folder"] };
	return null;
}

/** One picker at a time: every request would otherwise put another system window on screen. */
let open = false;

export function pickFolder(): Promise<string | null> {
	const run = command();
	if (run === null) return Promise.reject(new Refusal(501, "this computer has no system folder picker the page can open"));
	if (open) return Promise.reject(new Refusal(409, "a folder picker is already open"));
	open = true;
	return new Promise((resolve, reject) => {
		execFile(run.cmd, [...run.args], { timeout: 10 * 60_000, encoding: "utf8" }, (err: ExecFileException | null, stdout, stderr) => {
			open = false;
			if (err === null) return resolve(stdout.trim().replace(/(.)\/$/, "$1") || null);
			if (err.code === "ENOENT") return reject(new Refusal(501, `${run.cmd} is not installed`));
			if (err.code === 1) return /canceled|cancelled/i.test(stderr) || stderr.trim() === "" ? resolve(null) : reject(new Refusal(500, stderr.trim().slice(0, 200)));
			reject(new Refusal(500, err.message.slice(0, 200)));
		});
	});
}
