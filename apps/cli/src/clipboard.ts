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

/**
 * E1 §3 — THE LAST ANSWER, from the record rather than from the screen.
 *
 * The source is the session's PROJECTION (`session.projected()`), which
 * is derived from committed events: a message a retry or an abort voided
 * is already absent from it, and so is anything still streaming. Two
 * things this deliberately is NOT:
 *
 *   - the rendered rows, which are folded, washed and cut — a paste of
 *     those is a paste of the terminal's layout, not of the answer;
 *   - a join of the trailing `text_delta` frames, which are a live
 *     projection and not a record.
 *
 * Null when there is no complete answer yet, so the caller can say so
 * rather than copying an empty string over whatever the user had.
 */
export function lastAnswer(messages: readonly import("@vincemakes/kiso-core").Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		// A turn that only called tools said nothing to copy. Its blocks
		// are real, so `blocks.length > 0` is not the test — the test is
		// whether any of them is TEXT.
		const text = m.blocks
			.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("\n\n");
		if (text !== "") return text;
	}
	return null;
}

/** What the clipboard route did, and the one sentence the status row may
 *  say about it. The message is the product of this function because the
 *  claim and the act must not be able to drift apart. */
export interface ClipboardWrite {
	readonly ok: boolean;
	readonly message: string;
}

interface WriteEnv {
	readonly platform: string;
	readonly isTTY: boolean;
	readonly run: (cmd: string, args: readonly string[], stdin?: string) => { status: number | null };
	readonly write: (s: string) => void;
}

/**
 * E1 §3 — PUT TEXT ON THE CLIPBOARD, and say only what happened.
 *
 * Two routes, and they differ in what they can KNOW:
 *
 *   - **darwin, `pbcopy`**: a real process with a real exit status. When
 *     it succeeds we can say `copied`. When it fails we say so.
 *   - **everywhere else, OSC 52**: a REQUEST to the terminal. Most
 *     terminals do not answer it and Apple Terminal does not implement
 *     it at all, so there is no success to report — only that we asked.
 *     The row says `asked the terminal to copy N chars`. An earlier
 *     draft said `copied N chars (via the terminal)`, which still leads
 *     with "copied"; a reader takes the first word.
 *
 * And a route that does not exist: **stdout that is not a TTY emits
 * nothing**. An OSC written into a pipe is escape bytes in someone's
 * data.
 */
export function clipboardWrite(text: string, env: Partial<WriteEnv> = {}): ClipboardWrite {
	const platform = env.platform ?? process.platform;
	const isTTY = env.isTTY ?? process.stdout.isTTY === true;
	const run = env.run ?? ((cmd, args, stdin) => spawnSync(cmd, [...args], { input: stdin, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }));
	const write = env.write ?? ((s: string) => process.stdout.write(s));
	const n = [...text].length;
	// NO TTY, NO COPY — and this is checked BEFORE the platform, which is
	// the correction the pipe gate forced.
	//
	// The first build let darwin's `pbcopy` run regardless, on the
	// reasoning that pbcopy is a process and not a terminal route so it
	// works with stdout redirected. It does work — and that is the
	// problem: a script running `kiso chat < input.txt` would silently
	// overwrite whatever the human had on their clipboard. A side effect
	// on the user's desktop is not something a pipe should be able to
	// cause by accident.
	if (!isTTY) return { ok: false, message: "no terminal to copy to" };
	if (platform === "darwin") {
		const r = run("pbcopy", [], text);
		return r.status === 0
			? { ok: true, message: `copied ${n} chars` }
			: { ok: false, message: `could not copy — pbcopy exited ${r.status ?? "abnormally"}` };
	}
	write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
	return { ok: true, message: `asked the terminal to copy ${n} chars` };
}
