/**
 * E3 — the project-level trust gate through the CLI's topmost entry
 * (ADR-0037): capability is trusted by content digest, not by directory.
 *
 * The seven acceptance flows ①-⑦ — first-discovery ask (y/n), granted
 * restart without re-ask, digest change re-asks, non-TTY refusal with one
 * stderr hint, cross-level name conflict, refused stickiness — run against
 * FULLY isolated homes (the shared helper), with the project artifacts in
 * the CLI's own temp working directory. PTY phases use the same python3
 * pty driver pattern as the E1 gate: needles in the stream trigger the fed
 * lines, so the trust question either gets answered or the test fails.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import { projectArtifacts } from "@vincemakes/kiso-runtime";
import { applyProjectMerges } from "../src/index.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: fork a pty, exec the CLI in it, and feed each
 *  (needle, text) pair exactly once when the needle appears in the stream.
 *  Whatever the CLI says — including a trust prompt the test forgot to
 *  answer — ends up in stdout for the assertions. */
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

/** One PTY chat session: feeds answer the trust question and close the
 *  REPL; the returned transcript is what the CLI wrote to the pty. */
function ptyRun(env: NodeJS.ProcessEnv, cwd: string, feeds: [string, string][]): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(cwd)}, ${JSON.stringify(feeds)}, 40)
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

/** A fresh working directory with .kiso artifacts. */
function projectWorkdir(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "kiso-work-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = join(cwd, ".kiso", rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, content, "utf8");
	}
	return cwd;
}

function lintExt(name = "lint-rules"): string {
	return `export default { name: "${name}", tools: [] };\n`;
}

/** The trust.jsonl lines as parsed records. */
function trustLines(home: string): { root: string; digest: string; decision: string; ts: string }[] {
	return readFileSync(join(home, "trust.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { root: string; digest: string; decision: string; ts: string });
}

/** Write a granted record for the CURRENT artifacts — the way a previous
 *  interactive grant would have left it. Written directly (never through
 *  recordTrust: the test process must not touch the real ~/.kiso). */
async function preGrant(home: string, cwd: string): Promise<void> {
	const artifacts = await projectArtifacts(cwd);
	expect(artifacts).not.toBeNull();
	writeFileSync(
		join(home, "trust.jsonl"),
		`${JSON.stringify({ root: artifacts!.root, digest: artifacts!.digest, decision: "granted", ts: "test" })}\n`,
		"utf8",
	);
}

describe("E3: the project trust gate (project-trust)", () => {
	it("① first discovery on a TTY asks once — y grants, loads, and records granted", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/lint-rules.mjs": lintExt() });
		const out = ptyRun(env, cwd, [
			["trust this project's .kiso?", "y\n"],
			["you> ", "\n"],
		]);
		expect(out).toContain("[project .kiso]");
		expect(out).toMatch(/extensions\/lint-rules\.mjs\s+\([0-9a-f]{6}\)/); // file name + digest short prefix
		expect(out).toContain("[1 extension: project: lint-rules]"); // loaded, counted as project
		const lines = trustLines(dirs.home);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.decision).toBe("granted");
		const artifacts = await projectArtifacts(cwd);
		expect(lines[0]!.root).toBe(artifacts!.root);
		expect(lines[0]!.digest).toBe(artifacts!.digest);
	});

	it("② n refuses — recorded, nothing loads", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/lint-rules.mjs": lintExt() });
		const out = ptyRun(env, cwd, [
			["trust this project's .kiso?", "n\n"],
			["you> ", "\n"],
		]);
		expect(out).toContain("trust this project's .kiso?");
		expect(out).not.toContain("[1 extension"); // nothing loaded
		const lines = trustLines(dirs.home);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.decision).toBe("refused");
	});

	it("③ a granted record loads directly on restart — no re-ask", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/lint-rules.mjs": lintExt() });
		ptyRun(env, cwd, [
			["trust this project's .kiso?", "y\n"],
			["you> ", "\n"],
		]);
		const out = ptyRun(env, cwd, [["you> ", "\n"]]); // no trust answer available
		expect(out).not.toContain("trust this project's .kiso?");
		expect(out).toContain("[1 extension: project: lint-rules]");
		expect(trustLines(dirs.home)).toHaveLength(1); // no new record
	});

	it("④ a changed artifact file changes the digest — the gate re-asks", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/lint-rules.mjs": lintExt() });
		ptyRun(env, cwd, [
			["trust this project's .kiso?", "y\n"],
			["you> ", "\n"],
		]);
		writeFileSync(join(cwd, ".kiso", "extensions", "lint-rules.mjs"), `// v2 — the rules changed\n${lintExt()}`, "utf8");
		const out = ptyRun(env, cwd, [
			["trust this project's .kiso?", "y\n"],
			["you> ", "\n"],
		]);
		expect(out).toContain("trust this project's .kiso?"); // re-asked — the old grant died with the files
		expect(out).toContain("[1 extension: project: lint-rules]");
		const lines = trustLines(dirs.home);
		expect(lines).toHaveLength(2); // the old grant + the new one
		expect(lines[0]!.digest).not.toBe(lines[1]!.digest);
	});

	it("⑤ non-TTY never asks, never loads — one stderr hint, no record", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/lint-rules.mjs": lintExt() });
		const res = runCli(["chat"], env, { cwd });
		expect(res.status).toBe(0);
		expect(res.stderr).toContain("[project .kiso] found 1 artifact(s)");
		expect(res.stderr).toContain("not trusted, not loaded");
		expect(res.stdout).not.toContain("trust this project's");
		expect(res.stdout).not.toContain("[1 extension");
		expect(existsSync(join(dirs.home, "trust.jsonl"))).toBe(false); // no verdict recorded — nobody decided
	});

	it("⑥ a name in both user-level and project-level extensions is a loud startup error", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/dupe.mjs": lintExt("dupe") });
		writeFileSync(join(dirs.extensions, "dupe.mjs"), lintExt("dupe"), "utf8");
		await preGrant(dirs.home, cwd); // the gate passes; the conflict surfaces at load time
		const res = runCli(["chat"], env, { cwd });
		expect(res.status).not.toBe(0);
		expect(res.stderr).toContain('extension name "dupe" exists in both the user-level and the project-level');
		expect(res.stdout).not.toContain("[2 extension"); // died at startup — nothing loaded
	});

	it("⑦ a refused record is sticky — no re-ask, nothing loads", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({ "extensions/lint-rules.mjs": lintExt() });
		ptyRun(env, cwd, [
			["trust this project's .kiso?", "n\n"],
			["you> ", "\n"],
		]);
		const out = ptyRun(env, cwd, [["you> ", "\n"]]);
		expect(out).not.toContain("trust this project's .kiso?"); // refused is a record — never re-asked
		expect(out).not.toContain("[1 extension");
		expect(trustLines(dirs.home)).toHaveLength(1);
	});

	it("an mcp server name in both configs is a loud startup error", async () => {
		const { env, dirs } = isolatedEnv();
		const cwd = projectWorkdir({
			"mcp.json": JSON.stringify({ mcpServers: { dup: { command: "/bin/echo", args: ["a"] } } }),
		});
		rmSync(dirs.mcpConfig, { recursive: true, force: true }); // the helper's placeholder is a dir
		writeFileSync(dirs.mcpConfig, JSON.stringify({ mcpServers: { dup: { command: "/bin/echo", args: ["a"] } } }), "utf8");
		await preGrant(dirs.home, cwd);
		const res = runCli(["chat"], env, { cwd });
		expect(res.status).not.toBe(0);
		expect(res.stderr).toContain('mcp server "dup" exists in both the user-level and the project-level mcp.json');
	});
});

describe("E3: the mcp/skills merge (applyProjectMerges)", () => {
	it("merges project mcp.json with the user config into one temp config file", async () => {
		const { env, dirs } = isolatedEnv();
		const userMcp = JSON.stringify({ mcpServers: { alpha: { command: "/bin/echo", args: ["a"] } } });
		const cwd = projectWorkdir({
			"mcp.json": JSON.stringify({ mcpServers: { beta: { command: "/bin/echo", args: ["b"] } } }),
		});
		rmSync(dirs.mcpConfig, { recursive: true, force: true });
		writeFileSync(dirs.mcpConfig, userMcp, "utf8");
		process.env.KISO_MCP_CONFIG = dirs.mcpConfig;
		try {
			const artifacts = await projectArtifacts(cwd);
			expect(artifacts).not.toBeNull();
			applyProjectMerges(artifacts!);
			expect(process.env.KISO_MCP_CONFIG).not.toBe(dirs.mcpConfig); // now a merged temp file
			const merged = JSON.parse(readFileSync(process.env.KISO_MCP_CONFIG, "utf8")) as {
				mcpServers: Record<string, unknown>;
			};
			expect(Object.keys(merged.mcpServers).sort()).toEqual(["alpha", "beta"]);
		} finally {
			if (process.env.KISO_MCP_CONFIG !== undefined && process.env.KISO_MCP_CONFIG !== dirs.mcpConfig) {
				rmSync(process.env.KISO_MCP_CONFIG, { force: true });
			}
			delete process.env.KISO_MCP_CONFIG;
		}
	});

	it("merges project skills with the user skills into one temp scan dir (project wins on collision)", async () => {
		const { env, dirs } = isolatedEnv();
		const userSkill = "---\nname: user-skill\ndescription: from the user\n---\nuser body\n";
		const projectSkill = "---\nname: proj-skill\ndescription: from the project\n---\nproj body\n";
		const cwd = projectWorkdir({ "skills/proj-skill/SKILL.md": projectSkill });
		mkdirSync(join(dirs.skills, "user-skill"), { recursive: true });
		writeFileSync(join(dirs.skills, "user-skill", "SKILL.md"), userSkill, "utf8");
		process.env.KISO_SKILLS_DIR = dirs.skills;
		try {
			const artifacts = await projectArtifacts(cwd);
			expect(artifacts).not.toBeNull();
			applyProjectMerges(artifacts!);
			expect(process.env.KISO_SKILLS_DIR).not.toBe(dirs.skills); // now a temp merged dir
			const mergedDirs = readdirSyncSafe(process.env.KISO_SKILLS_DIR);
			expect(mergedDirs.sort()).toEqual(["proj-skill", "user-skill"]);
			expect(readFileSync(join(process.env.KISO_SKILLS_DIR, "proj-skill", "SKILL.md"), "utf8")).toBe(projectSkill);
			expect(readFileSync(join(process.env.KISO_SKILLS_DIR, "user-skill", "SKILL.md"), "utf8")).toBe(userSkill);
		} finally {
			if (process.env.KISO_SKILLS_DIR !== undefined && process.env.KISO_SKILLS_DIR !== dirs.skills) {
				rmSync(process.env.KISO_SKILLS_DIR, { recursive: true, force: true });
			}
			delete process.env.KISO_SKILLS_DIR;
		}
	});
});

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
