/**
 * XP-1 — the status row tells the truth across switches (the ratified
 * spec §2.1's live defect, closed structurally).
 *
 * The defect: `agentModel` is a CLI global written at startup and by
 * /model, and NEVER reset when chatLoop switches sessions — so after
 * `/model X` then `/resume <other>`, the other session RUNS its own
 * model while the row keeps saying X. The projection was honest; the
 * surface lied.
 *
 * The structural fix: every switched-to session repaints from ITS OWN
 * durable profile (session.model — restored from the sidecar), and a
 * /clear-fresh session INHERITS the live selection as a recorded
 * revision (clearing context never silently reverts the model).
 *
 * REAL kiso chat under a pty, faux provider; the /model target is a
 * keyless config profile (no request is ever sent to it).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, argv, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli] + argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    full = b""
    fed = set()
    end = time.time() + timeout
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

function ptyRun(argv: string[], env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 50): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-xp1st-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(argv)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 110_000, env: process.env });
}

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

describe("XP-1 — the row and the request agree, per session", () => {
	it("/clear inherits the live selection durably; /resume repaints the OTHER session's own truth", () => {
		const { env, dirs } = isolatedEnv();
		// a keyless profile the switch can target — no request ever fires.
		writeFileSync(
			join(dirs.home, "config.json"),
			`${JSON.stringify({
				models: { switched: { kind: "openai-compat", model: "visible-x", apiKeyEnv: "XP1_KEY", baseUrl: "http://127.0.0.1:9" } },
			})}\n`,
		);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-xp1st-w-"));
		const out = strip(
			ptyRun(
				["chat", "conv-a"],
				{ ...env, XP1_KEY: "fake" },
				[
					["/ commands · \u2191 history", "hello there\r"],
					["What would you like me to inspect", "/clear\r"],
					// inside the FRESH session: switch the live selection
					["previous: conv-a", "/model switched\r"],
					// back to conv-a — whose OWN profile is the faux default
					["takes effect on the next turn", "/resume conv-a\r"],
					["session conv-a (switched", "exit\r"],
				],
				workdir,
			),
		);

		// ── the durable half ──
		const metas = readdirSync(join(dirs.home, "sessions")).filter((f) => f.endsWith(".meta.json"));
		expect(metas.length).toBeGreaterThanOrEqual(2);
		const freshMeta = metas.find((f) => f !== "conv-a.meta.json")!;
		const fresh = JSON.parse(readFileSync(join(dirs.home, "sessions", freshMeta), "utf8")) as {
			profile: { modelId: string; revision: number };
		};
		// /model on the fresh session RECORDED the switch durably.
		expect(fresh.profile.modelId).toBe("visible-x");
		expect(fresh.profile.revision).toBeGreaterThanOrEqual(2);
		const convA = JSON.parse(readFileSync(join(dirs.home, "sessions", "conv-a.meta.json"), "utf8")) as {
			profile: { modelId: string };
		};
		// conv-a's own profile never moved — the switch happened elsewhere.
		expect(convA.profile.modelId).toBe("faux");

		// ── the display half: after resuming conv-a, the repainted idle
		// row carries CONV-A's model, not the other session's selection ──
		const back = out.lastIndexOf("session conv-a (switched");
		expect(back).toBeGreaterThanOrEqual(0);
		const after = out.slice(back);
		expect(after, "the row tells conv-a's truth").toContain("/mode to switch · faux");
		expect(after, "the other session's selection does not leak onto this row").not.toContain("/mode to switch · visible-x");
	});
});
