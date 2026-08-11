/**
 * ⑤ — the skills e2e: a REAL kiso chat through the CLI's topmost entry
 * with the BUILT bundle installed. Two skills sit in KISO_SKILLS_DIR; the
 * faux model calls read_skill — safe-defaults ALLOWS it (local docs,
 * read_file trust — no prompt), the SKILL.md body returns to the model,
 * the run completes; the startup banner counts the skills extension.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("../../../apps/cli", import.meta.url)), "dist", "index.js");
const BUNDLE = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "kiso-skills.mjs");
const SAFE_DEFAULTS = join(fileURLToPath(new URL("../../../examples", import.meta.url)), "extensions", "safe-defaults.mjs");

const PTY_DRIVER = `
import pty, os, sys, time, select

def driver(cli, home, workdir, ext_dir, skills_dir, script_path):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_SKILLS_DIR"] = skills_dir
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", "skills-e2e"])
    out = b""
    full = b""
    def read_until(needle, timeout):
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            idx = out.find(needle)
            if idx >= 0:
                out = out[idx + len(needle):]
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    out += data
                    full += data
                except OSError:
                    return False
        return False
    def wait_exit(timeout):
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        return
                    out += data
                    full += data
                except OSError:
                    return
    read_until(b"you> ", 20)
    os.write(fd, b"go\\n")
    # read_skill is AUTO-allowed by safe-defaults — no approval prompt.
    read_until(b"skill loaded", 40)
    os.write(fd, b"exit\\n")
    wait_exit(10)
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

const FAUX_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "s1", name: "read_skill", input: { name: "a-skill" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "text_delta", text: "skill loaded" }, { type: "stop", reason: "end_turn" }] },
];

describe("⑤ skills e2e (through the CLI's topmost entry)", () => {
	it("read_skill is auto-allowed (safe-defaults), the SKILL.md body returns to the model, done; the banner counts skills", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-skills-e2e-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		const skillsdir = join(dir, "skills");
		mkdirSync(home, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		copyFileSync(BUNDLE, join(extdir, "skills.mjs"));
		copyFileSync(SAFE_DEFAULTS, join(extdir, "safe-defaults.mjs"));
		for (const [name, meta] of [
			["b-skill", { description: "desc b" }],
			["a-skill", { description: "desc a" }],
		] as const) {
			const d = join(skillsdir, name);
			mkdirSync(d, { recursive: true });
			writeFileSync(
				join(d, "SKILL.md"),
				`---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# ${name}\n\nUNIQUE-BODY-${name}\n`,
				"utf8",
			);
		}
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(skillsdir)}, ${JSON.stringify(scriptPath)})
`;
		const { env } = isolatedEnv();
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env });
		// R-D 0.1.45: the user copy SHADOWS the built-in skills (the cascade
		// in a real CLI) — the built-in column lists the rest, the user
		// column stays file-name-sorted.
		expect(out).toContain("[5 extensions: built-in: mcp, subagent, task · safe-defaults, skills]");
		expect(out).not.toContain("approve read_skill"); // auto-allowed — no prompt
		expect(out).toContain("UNIQUE-BODY-a-skill"); // the SKILL.md body returned to the model
		expect(out).toContain("skill loaded");
	}, 180_000);

	it("⑨ a SYMLINKED skill works end to end (finding #9: `ln -s ~/.claude/skills/x ~/.kiso/skills/x` — the CC-compatible migration path)", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-skills-e2e-"));
		const home = join(dir, "home");
		const workdir = join(dir, "work");
		const extdir = join(dir, "ext");
		const skillsdir = join(dir, "skills");
		const realSkills = join(dir, "real-skills"); // the CC home — outside KISO_SKILLS_DIR
		mkdirSync(home, { recursive: true });
		mkdirSync(workdir, { recursive: true });
		mkdirSync(extdir, { recursive: true });
		mkdirSync(join(realSkills, "a-skill"), { recursive: true });
		writeFileSync(
			join(realSkills, "a-skill", "SKILL.md"),
			"---\ndescription: desc a\n---\n\n# a-skill\n\nUNIQUE-BODY-LINKED\n",
			"utf8",
		);
		mkdirSync(skillsdir, { recursive: true });
		symlinkSync(join(realSkills, "a-skill"), join(skillsdir, "a-skill"));
		copyFileSync(BUNDLE, join(extdir, "skills.mjs"));
		copyFileSync(SAFE_DEFAULTS, join(extdir, "safe-defaults.mjs"));
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(FAUX_TRAJECTORY), "utf8");
		writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");

		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(workdir)}, ${JSON.stringify(extdir)}, ${JSON.stringify(skillsdir)}, ${JSON.stringify(scriptPath)})
`;
		const { env } = isolatedEnv();
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env });
		expect(out).toContain("UNIQUE-BODY-LINKED"); // the symlinked skill's body returned to the model
		expect(out).not.toContain("unknown skill"); // it was discovered, not skipped
		expect(out).toContain("skill loaded");
	}, 180_000);
});
