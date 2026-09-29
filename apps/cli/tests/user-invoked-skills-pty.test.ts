/**
 * 0.40.0 — a person invokes a skill, end to end, in a real terminal.
 *
 * What the gate holds: `/skill hello world` is ONE user turn whose durable
 * `user_input` carries the SKILL.md body and the args (what the model
 * read) and a `via` naming the skill and the line typed; the chip on
 * screen is the line, never the body; `/skills` lists it; a model-only
 * skill and an unknown one are refused in one line each; and a resumed
 * session's tail shows the line.
 *
 * The body carries a mark that must NEVER reach the screen: it is what the
 * model reads, and a chip that echoed it would be the bug this field
 * exists to prevent. It is asserted absent from the terminal and present
 * in the log, so the gate cannot pass on a tree where the turn never ran.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const BODY_MARK = "BODY-ONLY-THE-MODEL-READS";

function skill(root: string, name: string, meta: string, body: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n${meta}---\n\n${body}\n`, "utf8");
}

describe("0.40.0 — user-invoked skills (PTY)", () => {
	it("the turn carries the body, the chip shows the line, refusals are one line, resume shows the line", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: "skill turn answered." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]),
		});
		skill(dirs.skills, "hello", "description: say hello properly\n", `Greet the person. ${BODY_MARK}`);
		skill(dirs.skills, "inner", "description: only for the model\nuser-invocable: false\n", "Model-only instructions.");
		const raw = ptyRun(["--mode", "bypass", "skill-pty"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "/skills\r"],
				["say hello properly", "/skill inner\r"],
				["user-invocable: false", "/skill helo\r"],
				["nearest: hello", "/skill hello world\r"],
				["skill turn answered.", "exit\r"],
			],
		});
		const out = strip(raw);
		// the list: name — description, the model-only tag
		expect(out).toContain("/hello — say hello properly");
		expect(out).toContain("/inner — only for the model (model only)");
		// the refusals, one line each
		expect(out).toContain('skill "inner" is for the model only (user-invocable: false)');
		expect(out).toContain('no skill named "helo" — nearest: hello (/skills lists them)');
		// the turn ran, and its chip is the typed line — never the body
		expect(out).toContain("skill turn answered.");
		expect(out).toContain("/skill hello world");
		expect(out, "the SKILL.md body reached the screen").not.toContain(BODY_MARK);

		// the durable record: the body + args for the model, `via` for display
		const sessions = join(dirs.home, "sessions");
		const file = readdirSync(sessions).find((f) => f.startsWith("skill-pty") && f.endsWith(".jsonl"));
		expect(file, "the session log exists").toBeDefined();
		const inputs = readFileSync(join(sessions, file!), "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => (JSON.parse(l) as { event: { type: string; content?: unknown; source?: unknown; via?: unknown } }).event)
			.filter((e) => e.type === "user_input");
		expect(inputs).toHaveLength(1);
		expect(inputs[0]!.content).toBe(`Greet the person. ${BODY_MARK}\n\nworld`);
		expect(inputs[0]!.via).toEqual({ kind: "skill", name: "hello", line: "/skill hello world" });
		expect(inputs[0]!.source, "a person's turn keeps the typed turn's shape — no new source").toBeUndefined();

		// resumed: the tail names the turn by what was typed
		const resumed = strip(
			ptyRun(["--mode", "bypass", "resume", "skill-pty"], env as NodeJS.ProcessEnv, {
				feeds: [["resuming", "exit\r"]],
			}),
		);
		expect(resumed).toContain("/skill hello world");
		expect(resumed, "the resume tail printed the SKILL.md body").not.toContain(BODY_MARK);
	}, 300_000);

	it("0.40.1 — typing `/b` offers the installed boss-call skill in the menu", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript([...spares(3)]) });
		skill(dirs.skills, "boss-call", "description: mailbox between sessions\n", "Body.");
		const out = strip(
			ptyRun(["--mode", "bypass", "skill-menu"], env as NodeJS.ProcessEnv, {
				feeds: [
					// the ctx segment is the BOOT status bar, painted after the
					// agent (and its extensions) exist — a key typed before it
					// reads an empty catalog
					[" · ctx ", "/b"], // Graphite §8.9: the bar's ctx segment (used share) — one plain span, so it matches the raw stream
					// the menu styles the typed prefix, so the raw bytes split
					// "/b" from the rest — the needle is the unsplit part
					["oss-call", "\x15exit\r"],
				],
			}),
		);
		// the menu draws its entries without the leading slash
		// Graphite §8.2 (R3a): the selected row carries the list's `→` (a gold
	// `›` on a known ground) right before the name, not a bold `▸`
	expect(out).toMatch(/[\u2192\u203a]boss-call\s+mailbox between sessions · skill/);
	}, 300_000);
});
