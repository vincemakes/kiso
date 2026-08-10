#!/usr/bin/env node
/**
 * The release smoke — runs the RELEASED artifacts, not the dist tree:
 *
 *  1. packs the CLI's full dependency closure (tier-C style, same as
 *     scripts/smoke.mjs) and installs into a clean project
 *  2. drives the INSTALLED `kiso` bin in a real pty (24×80): ONE turn
 *     with a diff-shaped tool result, then a NARROW WINCH (80 → 40 —
 *     the W17 narrow-width domain, resizing mid-flight), asserts the
 *     response rendered, the dock rows survived the winch, no pre-clear
 *  3. runs the five tui-lab scenarios (scratchpad/tui-lab/run-all.mjs)
 *     against the SAME installed binary (KISO_LAB_CLI)
 *
 * Exit 0 on pass / 1 on fail. Run at the release commit, after the
 * version bump, before tagging.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const HERE = dirname(fileURLToPath(import.meta.url));

/** The CLI's closure — the same set scripts/smoke.mjs tier C installs. */
const CLI_CLOSURE = [
	"@vincemakes/kiso-core",
	"@vincemakes/kiso-evals",
	"@vincemakes/kiso-runtime",
	"@vincemakes/kiso-tools-node",
	"@vincemakes/kiso-provider-anthropic",
	"@vincemakes/kiso-provider-openai",
	"@vincemakes/kiso-tui",
	"@vincemakes/kiso-code",
];

function pack(stage, name) {
	const out = execSync(`npm pack --json -w ${name} --pack-destination ${stage}`, { cwd: ROOT, encoding: "utf8" });
	const parsed = JSON.parse(out.slice(out.indexOf("[")));
	const file = parsed[0]?.filename;
	if (!file) throw new Error(`npm pack gave no filename for ${name}:\n${out}`);
	return join(stage, file);
}

function installReleasedClosure(label) {
	const proj = mkdtempSync(join(tmpdir(), `kiso-release-${label}-`));
	writeFileSync(join(proj, "package.json"), JSON.stringify({ name: `kiso-${label}`, private: true, type: "module" }, null, 2));
	const stage = mkdtempSync(join(tmpdir(), `kiso-release-pack-`));
	const tarballs = CLI_CLOSURE.map((n) => pack(stage, n));
	for (const tarball of tarballs) {
		execSync(`npm install --no-audit --no-fund --no-package-lock "${tarball}"`, { cwd: proj, stdio: "inherit" });
	}
	rmSync(stage, { recursive: true, force: true });
	return proj;
}

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(bin, env, feeds, timeout, winch=None, winch_at=b"", workdir=None):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        if workdir:
            os.chdir(workdir)
        # the installed npm bin is a shebang wrapper — exec it directly,
        # the kernel honors the shebang and the pty stays attached
        os.execvp(bin, [bin] + ["chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    winch_sent = False
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
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
        if winch is not None and not winch_sent and winch_at.encode() in full:
            winsize(*winch)
            os.kill(pid, signal.SIGWINCH)
            winch_sent = True
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

function ptyRun(bin, env, feeds, opts) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-release-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const winch = opts.winch === undefined ? "None" : JSON.stringify(opts.winch);
	const workdir = opts.cwd === undefined ? "None" : JSON.stringify(opts.cwd);
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(bin)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${opts.timeout ?? 40}, ${winch}, ${JSON.stringify(opts.winchAt ?? "")}, ${workdir})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
}

const stripANSI = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error("FAIL:", msg);
};

// ── 1. the released closure ─────────────────────────────────────────────
const proj = installReleasedClosure("smoke");
const bin = join(proj, "node_modules", ".bin", "kiso");
if (!existsSync(bin)) fail(`no installed kiso bin at ${bin}`);
console.log(`[release-smoke] installed the released closure; kiso at ${bin}`);

// ── 2. one turn, then the narrow winch ──────────────────────────────────
// An edit_file APPROVAL: the mini-diff (W17's cap domain, CAP_DIFF = 12)
// renders while the question is pending. The winch (80 → 40) lands
// mid-approval — the narrow redraw re-caps the diff at 40 cols (the W17
// cut row truncates to "· /last f…"), and the dock survives. Then
// approve, the edit settles, the response comes.
const dir = mkdtempSync(join(tmpdir(), "kiso-release-run-"));
const script = join(dir, "faux.json");
// the file on disk: 40 rows; the edit swaps all 40 for a new set — the
// LCS diff is 40 −/40 + rows, way past CAP_DIFF — the head 5 fold rows
// (2 context + identifier0..2) are what the stream shows at any width
const oldLines = Array.from({ length: 40 }, (_, i) => `const identifier${i} = ${i};`);
const newLines = Array.from({ length: 40 }, (_, i) => `const renamed${i} = fn(${i});`);
writeFileSync(join(dir, "f1.ts"), oldLines.join("\n"), "utf8");
// turn 1 = the edit_file call (the kernel asks, shows the mini-diff,
// runs the tool on approval); turn 2 = the assistant's text response.
// tool_result is kernel-owned — the provider never emits it.
writeFileSync(
	script,
	JSON.stringify([
		{
			events: [
				{
					type: "tool_call_end",
					callId: "r1",
					name: "edit_file",
					input: { path: "f1.ts", search: oldLines.join("\n"), replace: newLines.join("\n") },
				},
				{ type: "stop", reason: "tool_use" },
			],
		},
		{ events: [{ type: "text_delta", text: "the narrow winch is done." }, { type: "stop", reason: "end_turn" }] },
	]),
	"utf8",
);
const env = { ...process.env, KISO_FAUX_SCRIPT: script, KISO_HOME: join(dir, "home") };
// the workspace = the child's cwd (chat.ts: workspaceRoot: process.cwd())
// — f1.ts is workspace-relative; the driver chdirs before exec
const out = ptyRun(
	bin,
	env,
	[
		["▌ ", "go\n"],
		// the W21 approval panel is a numbered selector (1 Yes / 2
		// don't-ask-again / 3 No) — the y/n prompt era is gone. The
		// needle must be PLAIN text: the rail is color-wrapped, so any
		// needle containing "│" can never match the raw byte stream
		["1 Yes", "1\n"],
		["the narrow winch is done.", "exit\n"],
	],
	{ cwd: dir, winch: [18, 40], winchAt: "identifier2" },
);
const plain = stripANSI(out);

// the response rendered ONCE, in whole, after the winch — no pre-clear,
// no re-issued banner
if (!plain.includes("the narrow winch is done.")) fail("the turn's response missing");
if ((plain.match(/the narrow winch is done\./g) ?? []).length !== 1) fail("the response rendered more than once");
if (out.includes("\x1b[2J") || out.includes("\x1b[3J")) fail("a pre-clear sequence (ED2/ED3J)");
// the WINCH actually happened: the W21 fold notice ("└ +N more rows —
// the full args are in the event log") is 52 cells, so at 40 cols
// (W−2 = 38) cutLine re-cuts it right after "in" — "…in…". At 80 cols
// it fits whole, so the ellipsis form only exists when the narrow
// re-cap re-measured the panel mid-approval (the W17 assertion's
// "· /last f…" footer was the pre-W21 text — gone since the panel
// rewrite)
if (!plain.includes("the full args are in…")) fail("the narrow re-cap missing — the fold notice not re-cut at 40");
// the COMPACT banner re-renders after the winch (the V6-1 frozen-loop
// fix — the banner survives the resize repaint): at 18×40 the tier
// table picks COMPACT (W ≥ 40, 14–19 rows) — the top row proves the
// narrow redraw re-derived the banner at the new width (DROPPED for
// 0.1.37 — the released closure had the frozen-loop bug; RETURNS here)
if (!plain.includes("█ █ ▀█▀ █▀▀ █▀█")) fail("no compact banner after the winch — the narrow redraw never re-rendered it");
// the dock survived the winch: the box rails ╭╰, the input ›, and the
// approval DIFF rows with the │ gutter — the narrow cap's budget held
if (!plain.includes("╭") && !plain.includes("╰")) fail("no box rail after the winch");
if (!plain.includes("› ")) fail("no input row after the winch");
if (!plain.includes("│")) fail("no diff gutter row — the narrow diff missing");
if (!plain.includes("const identifier2 = 2;")) fail("the approval diff rows missing");
if (!failed) console.log("[release-smoke] ✓ one turn + the 80→40 winch: response whole, dock rows intact, the diff capped, no pre-clear");

// ── 3. the five lab scenarios against the same released binary ──────────
const labEnv = { ...process.env, KISO_LAB_CLI: bin };
try {
	execFileSync(process.execPath, [join(HERE, "tui-lab", "run-all.mjs")], { stdio: "inherit", timeout: 240_000, env: labEnv });
} catch {
	failed = true;
}
if (!failed) console.log("[release-smoke] ✓ the five tui-lab scenarios ran against the released binary");

if (failed) {
	console.error("\n[release-smoke] FAILED");
	process.exit(1);
}
console.log("\n[release-smoke] PASS — the released 0.1.x closure: one turn, the narrow winch, the five lab scenarios");
