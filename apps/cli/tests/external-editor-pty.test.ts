/**
 * §2.4 — ctrl+g hands the composer to `$VISUAL` / `$EDITOR` and takes it
 * back.
 *
 * The gesture never submits: what comes back is TEXT IN THE COMPOSER, and
 * enter is still the human's. An editor that fails leaves the buffer as it
 * was — a failed edit must not eat what you had written.
 *
 * The screen is repainted WHOLE on the way back, because the external
 * program drew over it: this is the same act as a settled resize and as
 * ctrl+o, so it takes the same path (R14 — erase the terminal and print
 * the session again) rather than patching the rows it can guess at.
 *
 * The fake editor rides PATH the way `kiso update`'s fake npm does: a
 * shell script that rewrites the file it is handed and exits.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, settledScreen, spares } from "./helpers/pty.js";

const EDITED = "the text the editor put there";

/** A stand-in for $EDITOR: it rewrites the file it is given, or fails. */
function fakeEditor(opts: { exit?: number; write?: string } = {}): string {
	const bin = mkdtempSync(join(tmpdir(), "kiso-fake-ed-"));
	const path = join(bin, "fake-editor");
	const body = opts.write === undefined ? "" : `printf '%s' ${JSON.stringify(opts.write)} > "$1"\n`;
	writeFileSync(path, `#!/bin/sh\n${body}exit ${opts.exit ?? 0}\n`, { mode: 0o755 });
	return path;
}

const script = (): string => fauxScript([{ events: [{ type: "text_delta", text: "seen it." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]);

function userInputs(home: string, id: string): string[] {
	// a session that never submitted a turn has no log at all, and that is
	// the answer this asks for rather than an error to trip over
	const file = join(home, "sessions", `${id}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => (JSON.parse(l) as { event?: { type?: string; content?: unknown } }).event)
		.filter((e) => e?.type === "user_input")
		.map((e) => String(e?.content ?? ""));
}

describe("§2.4 — ctrl+g opens the external editor", () => {
	it("the edited text comes back to the COMPOSER, unsent, and the screen is whole again", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), EDITOR: fakeEditor({ write: EDITED }) });
		const raw = ptyRun(["ext-a"], env as NodeJS.ProcessEnv, {
			feeds: [["/ commands · ↑ history", "half a thought"]],
			delays: [
				[3, "\x07"], // ctrl+g
				// ctrl+u empties the composer so `exit` is a command and not
				// more text appended to what came back from the editor
				[8, "\x15"],
				[10, "exit\r"],
			],
		});

		const screen = settledScreen(raw).join("\n");
		// the text is in the composer…
		expect(raw, "the editor's text came back").toContain(EDITED);
		// …and NOTHING was sent: the gesture edits, enter submits
		expect(userInputs(dirs.home, "ext-a").join("\n"), "the gesture never submits").not.toContain(EDITED);
		// …and the screen the external program drew over is whole again
		expect(screen, "the banner is back").toContain("WORKSPACE");
		expect(screen, "the rails are back").toContain("───");
		expect(screen, "the status row is back").toContain("/mode to switch");
	}, 240_000);

	it("an editor that FAILS leaves the buffer exactly as it was", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), EDITOR: fakeEditor({ exit: 3, write: EDITED }) });
		const raw = ptyRun(["ext-b"], env as NodeJS.ProcessEnv, {
			feeds: [["/ commands · ↑ history", "the words I typed"]],
			delays: [
				[3, "\x07"],
				[7, "\r"], // submit what is in the composer now
				[10, "exit\r"],
			],
		});
		expect(raw, "the failure is stated, not swallowed").toContain("exited 3");
		// the buffer is what the human typed — the failed edit is discarded
		expect(userInputs(dirs.home, "ext-b")).toEqual(["the words I typed"]);
	}, 240_000);

	it("with neither $VISUAL nor $EDITOR set, one line names both and the buffer is untouched", () => {
		// SET them empty, never delete them: the pty driver merges this env
		// ON TOP of the process environment, so a deleted key just means
		// "not overridden" and the developer's own $EDITOR is inherited —
		// which launches a real editor and hangs the scenario for its whole
		// wall. Absence has to be stated, not assumed.
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), EDITOR: "", VISUAL: "" });
		const raw = ptyRun(["ext-c"], env as NodeJS.ProcessEnv, {
			feeds: [["/ commands · ↑ history", "still mine"]],
			delays: [
				[3, "\x07"],
				[7, "\r"],
				[13, "exit\r"],
			],
		});
		expect(raw, "it names both variables").toContain("VISUAL");
		expect(raw).toContain("EDITOR");
		expect(userInputs(dirs.home, "ext-c")).toEqual(["still mine"]);
	}, 240_000);

	// A REGRESSION GUARD, not a proof of this change: it passes on a tree
	// where ctrl+g does nothing at all, because both halves of it are
	// "the terminal's own BEL changes nothing". It is here because DC-7 is
	// the family this key joins, and the guard is what keeps it closed.
	it("DC-7: a BEL inside an OSC reply is not ctrl+g", () => {
		// The terminal answers `ESC ] 11 ; rgb:… BEL`, and BEL is 0x07 —
		// the same byte the human presses. One comes from a person and one
		// comes from the terminal, and only the first opens an editor.
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), EDITOR: fakeEditor({ write: EDITED }) });
		const raw = ptyRun(["ext-d"], env as NodeJS.ProcessEnv, {
			feeds: [["/ commands · ↑ history", "typed by hand"]],
			delays: [
				// an OSC 11 answer, terminator and all — this must be swallowed
				[3, "\x1b]11;rgb:ffff/ffff/ffff\x07"],
				[6, "\r"],
				[9, "exit\r"],
			],
		});
		expect(raw, "the terminal's own BEL did not open the editor").not.toContain(EDITED);
		expect(userInputs(dirs.home, "ext-d"), "and it was not typed into the draft either").toEqual(["typed by hand"]);
	}, 240_000);
});
