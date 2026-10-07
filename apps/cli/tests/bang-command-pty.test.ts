/**
 * §2.2 — `!cmd` runs a shell command and SENDS it; `!!cmd` runs one and
 * shows it here only.
 *
 * The claim that matters is the difference, and it is not a rendering
 * difference: `!cmd` writes an ordinary user turn, so the command and its
 * output are in the durable log and the model sees them; `!!cmd` writes
 * nothing durable, because nothing is owed to a model that was never
 * told. Both run through the shell tool's own runner, so the timeout, the
 * output cap, the whole-tree kill and the STRIPPED environment are the
 * tool's — the `!`/`!!` difference is what the model sees, never what
 * leaves the machine.
 *
 * The durable log is the assertion surface rather than the screen: a body
 * cell proves something was drawn, and what is being claimed here is what
 * the model was handed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

/** Every `user_input` in the session's durable log — the event a turn
 *  writes, and the only place "the model was told this" is recorded. */
function userTurns(home: string, id: string): string[] {
	const file = join(home, "sessions", `${id}.jsonl`);
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => (JSON.parse(l) as { event?: { type?: string; content?: unknown } }).event)
		.filter((e) => e?.type === "user_input")
		.map((e) => String(e?.content ?? ""));
}

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const script = (): string => fauxScript([{ events: [{ type: "text_delta", text: "seen it." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]);

describe("§2.2 — the shell gesture", () => {
	it("!cmd sends the command and its output as a turn; !!cmd shows it and tells the model nothing", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script() });
		const raw = ptyRun(["chat", "bang-a"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "!echo marker-one\r"],
				["marker-one", "!!echo marker-two\r"],
				["marker-two", "exit\r"],
			],
		});

		// both reached the screen — the human ran two commands and saw both
		expect(raw).toContain("marker-one");
		// G3 (R2d): each as the person's command card, saying what became of
		// it — and no fence's markers on the screen (both used to print them)
		expect(raw).toContain("sent to the model");
		expect(raw).toContain("not sent");
		// (the terminal TITLE may still carry the fence: a session is named
		// from its first line as sent — the transcript is the subject here)
		expect(raw.replace(/\x1b\][^\x07]*\x07/g, "")).not.toContain("```console");
		expect(raw).toContain("marker-two");
		// the transcript shape: one fenced block per command, read as a
		// terminal would print it
		expect(raw).toContain("$ echo marker-one");
		expect(raw).toContain("$ echo marker-two");

		// the difference, on the surface that carries it
		const turns = userTurns(dirs.home, "bang-a").join("\n");
		expect(turns, "!cmd is an ordinary user turn").toContain("marker-one");
		expect(turns, "!!cmd tells the model nothing").not.toContain("marker-two");
	}, 240_000);

	it("esc kills a running command, and the session takes the next line", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script() });
		const raw = ptyRun(["chat", "bang-b"], env as NodeJS.ProcessEnv, {
			// the marker is written to a FILE, not echoed: `never-printed`
			// as an argument would appear on screen the moment the command
			// is drawn, and the assertion would be about the echo rather
			// than about whether the command ran.
			feeds: [["/mode to switch", `!sleep 20 && touch ${join(dirs.home, "ran-anyway")}\r`]],
			// esc lands while the sleep is still running; the command dies
			// with its whole process group, and the composer comes back.
			delays: [
				[3, "\x1b"],
				[5, "hello\r"],
				[8, "exit\r"],
			],
		});

		expect(raw, "the abort is announced").toContain("[aborting command]");
		expect(existsSync(join(dirs.home, "ran-anyway")), "the command died before its second half").toBe(false);
		// the session is alive: the line typed after the abort became a turn
		expect(userTurns(dirs.home, "bang-b").join("\n")).toContain("hello");
	}, 240_000);

	it("a line naming the credential store runs under neither ! nor !! — refused before it runs", () => {
		// kiso never serves its own credential store to a model, and `!cmd`
		// hands its output to one. HOME and KISO_HOME are a mkdtemp
		// directory: `~` below is never the real home, and the store holds
		// a canary, not a credential.
		const canary = "sk-canary-bang-0000";
		const home = realpathSync(mkdtempSync(join(tmpdir(), "kiso-bang-store-")));
		mkdirSync(join(home, ".kiso"));
		mkdirSync(join(home, "proj"));
		writeFileSync(join(home, ".kiso", "auth.json"), `${JSON.stringify({ version: 1, credentials: { deepseek: { type: "api-key", key: canary } } })}\n`, { mode: 0o600 });
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), HOME: home, KISO_HOME: join(home, ".kiso") });
		const raw = ptyRun(["chat", "bang-e"], env as NodeJS.ProcessEnv, {
			cwd: join(home, "proj"),
			feeds: [
				["/mode to switch", "!cat ~/.kiso/auth.json\r"],
				["~/.kiso/auth.json names", "!!cat $HOME/.kiso/auth.json\r"],
				["$HOME/.kiso/auth.json names", "exit\r"],
			],
		});
		// the person is told what to do instead
		expect(raw).toContain("Run it in your own terminal");
		expect(raw, "neither command ran").not.toContain(canary);
		expect(raw, "nothing was run").not.toContain("$ cat");
		const log = join(dirs.home, "sessions", "bang-e.jsonl");
		if (existsSync(log)) expect(readFileSync(log, "utf8"), "the model was told nothing of it").not.toContain(canary);
	}, 240_000);

	it("a PIPED session keeps ! as ordinary text — the gesture is the composer's alone", () => {
		// No dock, no composer, nobody typed it: a headless run whose input
		// began with `!` would be executing its own input. `-p` and
		// `--task-file` reach the dispatcher the same way this does.
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script() });
		execFileSync("node", [CLI, "chat", "bang-d"], {
			input: "!echo should-not-run\nexit\n",
			encoding: "utf8",
			env: { ...process.env, ...env } as NodeJS.ProcessEnv,
			timeout: 60_000,
		});
		const turns = userTurns(dirs.home, "bang-d").join("\n");
		expect(turns, "the line went to the model verbatim").toContain("!echo should-not-run");
		expect(turns, "nothing was run").not.toContain("$ echo should-not-run");
	}, 240_000);

	it("a backslash sends a line that really starts with !", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script() });
		ptyRun(["chat", "bang-c"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "\\!not-a-command\r"],
				["seen it.", "exit\r"],
			],
		});
		const turns = userTurns(dirs.home, "bang-c").join("\n");
		// the backslash is CONSUMED. Asserting only that `!not-a-command`
		// survives would pass on a tree with no gesture at all, because
		// `\\!not-a-command` contains it — a gate that cannot fail is not a
		// gate. What this pins is that the escape did its job.
		expect(turns, "the ! survives").toContain("!not-a-command");
		expect(turns, "the backslash was the escape, not content").not.toContain("\\!not-a-command");
		expect(turns, "nothing was run").not.toContain("$ not-a-command");
	}, 240_000);
});
