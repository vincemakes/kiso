/**
 * 0.40.0 dogfood item 6 — the typing-latency gate, in a real PTY.
 *
 * The owner typed Chinese into the composer and into the ask panel's
 * free-text field on Terminal.app and saw it lag. Measured before the
 * fix with KISO_TRACE_BYTES (the byte trace stamps every stdin chunk
 * and every stdout write in-process), 20 ASCII + 20 CJK keys:
 *   - composer, TERM_PROGRAM=Apple_Terminal: first paint 42 ms per key,
 *     ASCII and CJK alike — the 40 ms trailing frame window;
 *   - ask free-text field: 0–150 ms, uniformly — no frame was requested
 *     at all; the text rode the next spinner tick.
 * After: 1–3 ms in both.
 *
 * The gate: under TERM_PROGRAM=Apple_Terminal (the widest window), in
 * the composer and in the ask field, for ASCII and for CJK commits, the
 * first stdout write after each key lands under 15 ms at the median, and
 * nearly every key does (a loaded CI host may stall a key or two; a
 * trailing window never produces a single fast key, so the fraction
 * still discriminates).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const DRIVER = `
import os, pty, sys, time, select, struct, fcntl, termios, json
cli, cwd, env, pre, keys = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4]), json.loads(sys.argv[5])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe("node", ["node", cli, "chat", "latency"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
buf = b""
def pump(t, until=None):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.01)
        if r:
            try:
                buf += os.read(fd, 65536)
            except OSError:
                return
        if until is not None and until.encode() in buf:
            return
for needle, text in pre:
    pump(15, needle)
    pump(0.3)
    os.write(fd, text.encode())
pump(1.0)
for k in keys:
    os.write(fd, k.encode())
    pump(0.12)
pump(0.3)
os.kill(pid, 9)
os.waitpid(pid, 0)
sys.stdout.write("found" if all(n.encode() in buf for n, _ in pre) else "missing")
`;

const ASCII = [..."hello world"];
const CJK = [..."\u5e2e\u6211\u770b\u4e0b\u9879\u76ee\u7ed3\u6784\u7136\u540e"];

interface TraceLine {
	readonly ms: number;
	readonly dir: "in" | "out" | "err";
	readonly n: number;
	readonly b: string;
}

/** The first-paint latency of each typed key, in the order typed. */
function measure(pre: [string, string][], faux: unknown[] | null): number[] {
	const { env } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-latency-"));
	const cwd = join(dir, "ws");
	mkdirSync(cwd);
	const trace = join(dir, "bytes.jsonl");
	const driver = join(dir, "driver.py");
	writeFileSync(driver, DRIVER, "utf8");
	const extra: Record<string, string> = { KISO_TRACE_BYTES: trace, TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" };
	if (faux !== null) {
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify(faux), "utf8");
		extra.KISO_FAUX_SCRIPT = script;
	}
	const keys = [...ASCII, ...CJK];
	const found = execFileSync("python3", [driver, CLI, cwd, JSON.stringify({ ...env, ...extra }), JSON.stringify(pre), JSON.stringify(keys)], {
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(found, "a setup needle never appeared — the driver typed into the wrong surface").toBe("found");
	const lines = readFileSync(trace, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as TraceLine);
	const ins = lines.flatMap((l, i) => (l.dir === "in" ? [i] : []));
	const measured = ins.slice(-keys.length);
	expect(measured.map((i) => Buffer.from(lines[i]!.b, "base64").toString("utf8")), "the trace's last chunks are the typed keys").toEqual(keys);
	return measured.map((i) => {
		const out = lines.slice(i + 1).find((l) => l.dir === "out" || l.dir === "in");
		expect(out?.dir, `no paint before the next key after ${Buffer.from(lines[i]!.b, "base64").toString("utf8")}`).toBe("out");
		return out!.ms - lines[i]!.ms;
	});
}

function judge(label: string, ms: number[]): void {
	const sorted = [...ms].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	const fast = ms.filter((m) => m < 15).length;
	expect(median, `${label}: median first paint ${median} ms (all: ${ms.join(",")})`).toBeLessThan(15);
	expect(fast / ms.length, `${label}: ${fast}/${ms.length} keys under 15 ms (all: ${ms.join(",")})`).toBeGreaterThanOrEqual(0.8);
}

const READY = " · ctx "; // Graphite §8.9: the bar's ctx segment (used share) — one plain span, so it matches the raw stream

describe("item 6 — a typed key paints at once (TERM_PROGRAM=Apple_Terminal)", () => {
	it("the composer: ASCII and CJK", () => {
		const ms = measure([[READY, ""]], null);
		judge("composer ASCII", ms.slice(0, ASCII.length));
		judge("composer CJK", ms.slice(ASCII.length));
	}, 90_000);

	it("the ask panel's free-text field: ASCII and CJK", () => {
		const ask = {
			events: [
				{ type: "tool_call_end", callId: "q1", name: "ask_user", input: { questions: [{ question: "which name?", header: "name", options: [{ label: "a" }, { label: "b" }] }] } },
				{ type: "stop", reason: "tool_use" },
			],
		};
		const ms = measure(
			[
				[READY, "go\r"],
				["which name?", "t"],
				["your answer", ""],
			],
			[ask, { events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }],
		);
		judge("ask ASCII", ms.slice(0, ASCII.length));
		judge("ask CJK", ms.slice(ASCII.length));
	}, 90_000);
});
