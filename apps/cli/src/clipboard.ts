/**
 * REL-0152-D11 — reading an image off the clipboard.
 *
 * SPLIT from attachments.ts on purpose. The pty-manifest gate
 * classifies a test by its resource-dependency CLOSURE, and a module
 * that spawns drags every test that imports it into the serial pool.
 * The path scanning and the block building are pure and belong in the
 * fast pool; only this file needs a process, so only this file's tests
 * pay for one. The gate found that out, which is what it is for.
 */

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { sniff } from "./attachments.js";

/**
 * REL-0152-D11, the clipboard half.
 *
 * Pasting an image into a terminal sends NOTHING useful: the terminal
 * has no way to put binary into a byte stream, so a bracketed paste
 * arrives empty (or with a filename, depending on the source app). An
 * empty paste is therefore the signal — the user pressed paste and the
 * terminal had nothing to give us — and the image, if there is one, has
 * to be fetched from the clipboard directly.
 *
 * macOS only for now, through `osascript`, which is present on every
 * Mac and needs no dependency. The coercion `the clipboard as «class
 * PNGf»` is the documented way to get PNG bytes out of the pasteboard.
 *
 * KNOWN UNRESOLVED, and stated here rather than discovered later: that
 * coercion FAILS with error -1700 when osascript runs detached from the
 * user's session, which is where this was developed. `clipboard info`
 * correctly reports the PNG flavour is present, so it is not a
 * permission wall — it has the shape of a promised (lazily rendered)
 * flavour that the source app materialises only for a process in the
 * right session context. kiso runs in the user's own terminal session,
 * where it may simply work. This returns null on any failure and the
 * caller says so out loud; nothing here guesses.
 */
export function clipboardImage(dir: string, run: (cmd: string, args: readonly string[]) => { status: number | null } = defaultRun): string | null {
	if (process.platform !== "darwin") return null;
	const target = join(dir, `paste-${process.pid}-${Date.now()}.png`);
	const script = [
		"set d to (the clipboard as «class PNGf»)",
		`set f to open for access POSIX file ${JSON.stringify(target)} with write permission`,
		"set eof f to 0",
		"write d to f",
		"close access f",
	].flatMap((line) => ["-e", line]);
	try {
		const r = run("osascript", script);
		if (r.status !== 0) return null;
		// the file must be a real image by the SAME sniffer the path
		// route uses — a zero-byte file from a half-failed coercion is
		// exactly what this round already produced once
		const st = statSync(target);
		if (!st.isFile() || st.size === 0) return null;
		if (sniff(readFileSync(target)) === null) return null;
		return target;
	} catch {
		return null;
	}
}

function defaultRun(cmd: string, args: readonly string[]): { status: number | null } {
	return spawnSync(cmd, [...args], { stdio: "ignore", timeout: 5000 });
}
