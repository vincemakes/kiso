/**
 * KC3 T-A4 — the @ reference, end to end under a real pty.
 *
 * The round's acceptance, driven rather than asserted piecemeal: a
 * human types `look at @ra`, the picker shows range.js, Tab accepts,
 * Enter sends — and the DURABLE user_input carries the path text. That
 * last clause is the product decision made observable: what reaches
 * the log (and therefore the model) is a REFERENCE, not a file. The
 * test asserts the file's content is nowhere in the record.
 *
 * The driver is KC2's settle-and-stop: it stops as soon as every feed
 * has fired and every asserted outcome is on screen (plus a grace
 * window so the terminal and the idle repaint land durably), with the
 * timeout only as a hang net. Blocking a vitest worker for a whole
 * fixed window is what tripped the reporter's RPC in KC2.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** KC2's driver, with a CWD: the @ source lists the process's working
 *  directory, so the child chdirs into the fixture before exec. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, session, env, cwd, feeds, timeout, settle, grace):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat", session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    fed = set()
    t0 = time.time()
    end = t0 + timeout
    settled = None
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
        for i, (needle, text, delay) in enumerate(feeds):
            if i not in fed and time.time() - t0 >= delay and needle.encode() in full:
                os.write(fd, text.encode())
                fed.add(i)
        if settled is None and len(fed) == len(feeds) and all(s.encode() in full for s in settle):
            settled = time.time()
        if settled is not None and time.time() - settled >= grace:
            break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

function ptyRun(
	env: NodeJS.ProcessEnv,
	session: string,
	cwd: string,
	feeds: [string, string, number][],
	timeout: number,
	settle: string[],
	grace = 2,
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc3pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${JSON.stringify(cwd)}, ${JSON.stringify(feeds)}, ${timeout}, ${JSON.stringify(settle)}, ${grace})
`;
	const hex = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
	return Buffer.from(hex, "hex").toString("utf8");
}

interface Rec {
	readonly runId: string;
	readonly event: Record<string, unknown>;
}
const durable = (home: string, session: string): Rec[] =>
	readFileSync(join(home, "sessions", `${session}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Rec);
const inputs = (log: Rec[]): string[] => log.filter((r) => r.event.type === "user_input").map((r) => String(r.event.content));

/** The file the reference points at carries a MARKER no other part of
 *  the fixture does — if any byte of its content ever reached the log,
 *  the marker would be there to find. */
const MARKER = "SENTINEL_FILE_CONTENT_MUST_NEVER_BE_INJECTED";

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "kiso-kc3ws-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "range.js"), `// ${MARKER}\nexport const range = 1;\n`, "utf8");
	writeFileSync(join(root, "src", "editor.ts"), "export const editor = 1;\n", "utf8");
	writeFileSync(join(root, "notes.md"), "# notes\n", "utf8");
	return root;
}

function fauxScript(dir: string, turns: unknown[]): string {
	const p = join(dir, "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}
const quickTurn = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

describe("KC3 T-A4 — the acceptance run", () => {
	it("`look at @ra` → Tab → submit: the durable user_input carries the PATH, never the file", () => {
		const { env, dirs } = isolatedEnv();
		const ws = workspace();
		const script = fauxScript(ws, [quickTurn("acknowledged the reference")]);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
			"kc3a4",
			ws,
			[
				["/ commands · \u2191 history", "look at @ra", 2], // typed, NOT submitted — the picker opens
				["(1/", "\t", 3], // the counter proves the panel is up; Tab accepts
				["@src/range.js", "\r", 4], // the completed line submits
			],
			40,
			["acknowledged the reference"],
		);

		// the composer completed the token to the canonical path
		expect(out).toContain("look at @src/range.js");
		// the durable record carries the reference…
		const log = durable(dirs.home, "kc3a4");
		expect(inputs(log).length).toBe(1);
		expect(inputs(log)[0]).toContain("@src/range.js");
		// …and NOT one byte of the file it points at
		expect(inputs(log)[0]).not.toContain(MARKER);
		expect(readFileSync(join(dirs.home, "sessions", "kc3a4.jsonl"), "utf8")).not.toContain(MARKER);
		// the reference is CHEAP: a path, not a file
		expect(inputs(log)[0]!.length).toBeLessThan(40);
	}, 180_000);

	it("the panel is really on screen mid-type, and the chrome survives the whole exchange", () => {
		const { env, dirs } = isolatedEnv();
		const ws = workspace();
		const script = fauxScript(ws, [quickTurn("chrome check answered")]);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
			"kc3a4b",
			ws,
			[
				["/ commands · \u2191 history", "look at @ra", 2],
				["(1/", "\t", 3],
				["@src/range.js", "\r", 4],
			],
			40,
			["chrome check answered"],
		);
		// the panel rendered: the counter row and the selection band
		expect(out).toContain("(1/");
		// MOVED (R1.5 slice 8, the picker-row class — DECLARED THIS ROUND):
		// the selection is a full-width inverse BAR, not a two-cell marker,
		// and the directory rides beside the name instead of at the band's
		// far edge (VD-9). Both facts are still asserted, in their new forms.
		expect(out).toContain("\u001b[7m "); // the full-row selection bar
		// DECLARED SUPERSESSION (R2, design §2.1 — nothing dim ever sits on
		// the wash): the directory is still adjacent to the name and still
		// dim on an unselected row, but the dim is DROPPED inside the
		// selection bar, where grey-on-grey is 3.91:1 on the light ground.
		// The only match here is the selected one, so what the stream must
		// carry is the qualifier itself — and what it must never carry is
		// dim opened on top of the bar.
		expect(out).toContain("  — src/"); // the directory, adjacent
		expect(out).not.toContain("\u001b[7m\u001b[2m"); // never dim ON the bar
		expect(out).toContain("files"); // R1.5 7(b): the band names itself
		// the chrome is intact afterwards: the box, the lead, the status
		// R2 (law 1.1): the composer is two dashed rails, not a box. Both
		// rails are the same rule, so what the stream must carry is the
		// rule itself — the corners are retired.
		expect(out).toContain("\u254c\u254c\u254c");
		expect(out).toContain("/ commands");
		expect(out).toContain("chrome check answered");
		// and the picker is GONE once the line was sent
		expect(out.lastIndexOf("chrome check answered")).toBeGreaterThan(out.lastIndexOf("(1/"));
		expect(durable(dirs.home, "kc3a4b").length).toBeGreaterThan(0);
	}, 180_000);
});
