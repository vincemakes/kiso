/**
 * DC-34 — see the widen seam with your own eyes.
 *
 * Drives the REAL CLI in a pty at 60 columns, streams an answer, widens
 * the terminal to 100 mid-stream, and prints the resulting screen —
 * scrollback and all — so the seam is visible without you having to
 * catch it live.
 *
 *   npx tsx scripts/dc34-seam-demo.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Screen } from "../packages/tui/tests/helpers/screen.js";

const CLI = join(process.cwd(), "apps/cli/dist/index.js");
const NARROW = 60;
const WIDE = 100;
const ROWS = 24;

const PARAS = Array.from({ length: 14 }, (_, i) => {
	const n = i + 1;
	return `P${String(n).padStart(2, "0")} this paragraph is written to fold at sixty columns and to sit on one line at a hundred, so the seam is obvious. `;
});

const DRIVER = String.raw`
import pty, os, time, select, struct, fcntl, termios, signal, sys, json
def run(cli, cwd, script):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.pop("NO_COLOR", None)
        os.environ["KISO_HOME"] = cwd
        os.environ["HOME"] = cwd
        os.environ["TERM"] = "xterm-256color"
        os.environ["KISO_FAUX_SCRIPT"] = script
        os.environ["KISO_MODE"] = "bypass"
        os.chdir(cwd)
        os.execvp("node", ["node", cli])
    def win(c): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS_, c, 0, 0))
    sys.stderr.write("  driving the real CLI at NARROW_ columns...\n"); sys.stderr.flush()
    win(NARROW_)
    full = b""; start = time.time(); sent = False; off = -1
    while time.time() - start < 14:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: break
            if not d: break
            full += d
        if not sent and b"\xe2\x96\x8c" in full: os.write(fd, b"go\r"); sent = True
        if sent and off < 0 and b"P09" in full:
            off = len(full); win(WIDE_)
            sys.stderr.write("  widened to WIDE_ mid-answer\n"); sys.stderr.flush()
        if sent and b"\xe2\x9c\xa6 took" in full and time.time() - start > 2:
            sys.stderr.write("  the turn settled; letting it rest\n"); sys.stderr.flush()
            break
    dl = time.time() + 1.0
    while time.time() < dl:
        r, _, _ = select.select([fd], [], [], 0.2)
        if not r: continue
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        full += d
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    print(json.dumps({"off": off})); sys.stdout.write(full.hex()); sys.exit(0)
`.replace(/ROWS_/g, String(ROWS)).replace(/NARROW_/g, String(NARROW)).replace(/WIDE_/g, String(WIDE));

const dir = mkdtempSync(join(process.cwd(), ".kiso-demo-"));
try {
	const script = join(dir, "faux.json");
	writeFileSync(script, JSON.stringify([{ events: [...PARAS.map((text) => ({ type: "text_delta", text })), { type: "stop", reason: "end_turn" }] }]), "utf8");
	const driver = join(dir, "d.py");
	writeFileSync(driver, DRIVER, "utf8");
	console.log("\n  (about ten seconds — the CLI has to boot and stream)\n");
	const out = execFileSync("python3", ["-c", `import sys\nsys.argv=[""]\nexec(open(${JSON.stringify(driver)}).read())\nrun(${JSON.stringify(CLI)}, ${JSON.stringify(dir)}, ${JSON.stringify(script)})`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
	const nl = out.indexOf("\n");
	const { off } = JSON.parse(out.slice(0, nl)) as { off: number };
	const bytes = Buffer.from(out.slice(nl + 1).trim(), "hex");
	const s = new Screen(NARROW, ROWS);
	s.feed(bytes.subarray(0, off).toString("utf8"));
	s.resizeTo(WIDE);
	s.feed(bytes.subarray(off).toString("utf8"));

	const lines = s.allLines().map((l) => l.replace(/\s+$/, ""));
	const seen = new Map<string, number>();
	for (const l of lines) for (const m of l.matchAll(/P\d\d/g)) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
	const dupes = [...seen].filter(([, c]) => c > 1).map(([t]) => t);

	console.log(`\n  the terminal, top to bottom, after a widen ${NARROW} -> ${WIDE} mid-answer\n`);
	for (const [i, l] of lines.entries()) {
		if (l.trim() === "") continue;
		const width = l.length > NARROW ? "wide  " : "narrow";
		console.log(`  ${String(i).padStart(3)} ${width} │ ${l}`);
	}
	console.log(`\n  paragraphs printed once: ${[...seen].filter(([, c]) => c === 1).length}`);
	console.log(`  paragraphs printed TWICE: ${dupes.length}${dupes.length ? ` — ${dupes.join(" ")}` : ""}`);
	console.log(`\n  Everything above the seam keeps the fold it was printed with — it is\n  ink, and neither kiso nor the terminal re-wraps it. Below the seam the\n  live region took the new width. Before this fix the frame re-painted\n  the ink at the NEW width too, which is where the second copy came from.\n`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
