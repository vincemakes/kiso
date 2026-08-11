/**
 * R-D 0.1.45 (deliverable B) — the first-run scaffold on a REAL PTY
 * (the sentinel-file PTY gate):
 *
 * ① pre-trust zero-write: at the MOMENT the trust question appears, the
 *   FRESH home is empty — the sessions-dir mkdir that used to land
 *   before the verdict (SessionStore's constructor) moved behind the
 *   gate. The question is the process's first home access of any kind.
 * ② answering grants the project — only then the scaffold lands:
 *   config.json + the sentinel + the trust record, in the fixed
 *   first-run sequence gate → scaffold → banner → REPL. The scaffold is
 *   SILENT (every stream line must match a known cell format — the v2d
 *   lint — and the PTY grids pin the startup stream byte-for-byte), so
 *   the sequence is evidenced by the FILES: empty at the question, the
 *   scaffold + the trust record after, the banner after the question.
 * ③ the second run (the sentinel present): no question, no re-scaffold,
 *   no announcement — the home listing is untouched and the user's
 *   config is never clobbered.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const SCAFFOLD = `${JSON.stringify({ models: {} }, null, 2)}\n`;

/** The project-trust driver plus a HOME-SNAPSHOT hook: when the feed at
 *  index `snapshot` matches, the home's listing is captured (BEFORE the
 *  feed is written) and emitted as one marker line before the transcript
 *  — the pre-trust state, frozen at the exact moment of the question. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, json

def driver(cli, env, cwd, feeds, timeout, snapshot, home):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat"])
    out = b""
    full = b""
    fed = set()
    shot = None
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            out += data
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    if i == snapshot and shot is None:
                        shot = sorted(os.listdir(home))
                    os.write(fd, text.encode())
                    fed.add(i)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write("HOME_SNAPSHOT=" + json.dumps(shot) + "\\n" + full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, cwd: string, feeds: [string, string][], home: string, snapshot = 0): { transcript: string; snapshot: string[] } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-first-run-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(cwd)}, ${JSON.stringify(feeds)}, 40, ${snapshot}, ${JSON.stringify(home)})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
	const marker = out.indexOf("HOME_SNAPSHOT=");
	const lineEnd = out.indexOf("\n", marker);
	const snapshotList = JSON.parse(out.slice(marker + "HOME_SNAPSHOT=".length, lineEnd)) as string[];
	return { transcript: out.slice(lineEnd + 1), snapshot: snapshotList };
}

/** A fresh working directory with .kiso artifacts. */
function projectWorkdir(): string {
	const cwd = mkdtempSync(join(tmpdir(), "kiso-work-"));
	const p = join(cwd, ".kiso", "extensions", "lint-rules.mjs");
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, `export default { name: "lint-rules", tools: [] };\n`, "utf8");
	return cwd;
}

describe("R-D 0.1.45-B — the first-run scaffold (real PTY, sentinel file)", () => {
	it("① empty home at the trust question ② scaffold lands only after the grant, in the fixed sequence ③ second run: silent", () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir();

		// ── run 1: the FIRST run — the question is the first home access ──
		// (the exit needle is the banner, NOT the "▌ " prompt — the editor
		// renders its brick prompt BEFORE the question, so a "▌ " feed
		// would queue "exit" ahead of the "y" answer and the question
		// would read the wrong line)
		const first = ptyRun(
			env,
			cwd,
			[["trust this project's .kiso?", "y\n"], ["[5 extensions: built-in: mcp, skills, subagent, task · project: lint-rules]", "exit\n"]],
			dirs.home,
			0,
		);
		// ① the pre-trust state, frozen at the question: the fresh home is EMPTY
		expect(first.snapshot).toEqual([]);
		// ② the fixed first-run sequence: the question precedes the banner in
		//   the stream (the scaffold is silent — the FILES carry the evidence:
		//   empty at the question per the snapshot, the scaffold + the trust
		//   record asserted below)
		const q = first.transcript.indexOf("trust this project's .kiso?");
		const b = first.transcript.indexOf("[5 extensions: built-in: mcp, skills, subagent, task · project: lint-rules]");
		expect(q).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(q);
		// the scaffold landed: config + sentinel + the trust record
		expect(readFileSync(join(dirs.home, "config.json"), "utf8")).toBe(SCAFFOLD);
		expect(existsSync(join(dirs.home, "first-run"))).toBe(true);
		const trust = readFileSync(join(dirs.home, "trust.jsonl"), "utf8");
		expect(trust).toContain('"decision":"granted"');

		// ── run 2: the sentinel is present — silent, no re-ask, no re-scaffold ──
		const second = ptyRun(env, cwd, [["▌ ", "exit\n"]], dirs.home, 0);
		expect(second.transcript).not.toContain("trust this project's");
		expect(second.transcript).not.toContain("first run — scaffolded");
		// the home listing at run 2's prompt is EXACTLY the post-run-1 state —
		// the second run performs zero new home writes
		expect(second.snapshot).toEqual(readdirSync(dirs.home).sort());
		// the user's config is never clobbered
		expect(readFileSync(join(dirs.home, "config.json"), "utf8")).toBe(SCAFFOLD);
	});
});
