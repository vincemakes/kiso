/**
 * Graphite §8.10 — the terminal title follows the session's state, on a
 * real PTY: `kiso — <folder>` before there is a name, `✦ <name> — <folder>`
 * while a turn works, `❯ needs you · <name> — <folder>` while the person is
 * asked, and the ready form again once the turn ends. It changes when the
 * state changes and never on a tick, and nothing rings a bell.
 *
 * The PTY carries no window size, so the dock stays out and the question is
 * the dock-less `approve <tool>? (y/n)` — the same askPanel, the same title.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal

def driver(cli, env, cwd, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat"])
    out = b""
    full = b""
    fed = set()
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
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, dir: string, feeds: [string, string][]): string {
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(dir)}, ${JSON.stringify(feeds)}, 40)
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

describe("§8.10 — the title follows the state (real PTY)", () => {
	it("ready → working → needs you → working → ready; never per tick, never a bell", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-title-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "made.txt", content: "x", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "delay", ms: 1200 }, { type: "text_delta", text: "wrote it" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script } as NodeJS.ProcessEnv, dir, [
			["▌ ", "write the made file please\r"],
			["approve write_file", "y\r"],
			["wrote it", "exit\r"],
		]);
		const folder = basename(dir);
		const titles = [...out.matchAll(/\u001b\]0;([^\u0007]*)\u0007/g)].map((m) => m[1]!);
		const name = "write the made file please";
		expect(titles[0], titles.join("\n")).toBe(`kiso — ${folder}`);
		const i1 = titles.findIndex((t) => t.startsWith("✦ "));
		const i2 = titles.findIndex((t, i) => i > i1 && t === `❯ needs you · ${name} — ${folder}`);
		const i3 = titles.findIndex((t, i) => i > i2 && t === `✦ ${name} — ${folder}`);
		expect(i1, titles.join("\n")).toBeGreaterThan(0);
		expect(i2, `the question wears ❯\n${titles.join("\n")}`).toBeGreaterThan(i1);
		expect(i3, `the answer puts ✦ back\n${titles.join("\n")}`).toBeGreaterThan(i2);
		expect(titles.at(-1), "the turn's end — and the exit — leave the ready form").toBe(`${name} — ${folder}`);
		// a title that changed per tick would repeat forms; each state is
		// written once per transition (the 1.2 s answer spans six ticks)
		for (let i = 1; i < titles.length; i += 1) expect(titles[i], `written twice in a row\n${titles.join("\n")}`).not.toBe(titles[i - 1]);
		expect(titles.length, titles.join("\n")).toBeLessThanOrEqual(8);
		// no bell outside the OSC terminators
		expect(out.replace(/\u001b\][^\u0007]*\u0007/g, "")).not.toContain("\u0007");
	}, 90_000);
});
