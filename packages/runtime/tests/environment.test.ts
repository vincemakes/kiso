/** ADR-0058 Amendment 19: a Work's added-folder list. */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addFolder, EnvironmentRefusedError, environmentFile, readEnvironment, removeFolder } from "../src/environment.js";
import { forkSession } from "../src/fork.js";

const dir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "kiso-env-")));
const world = () => ({ store: dir(), primary: dir(), stops: [] as string[] });

describe("the list", () => {
	it("is empty with no file, and keeps real paths", () => {
		const { store, primary, stops } = world();
		expect(readEnvironment(store, "s")).toEqual({ added: [], damaged: false });
		const f = dir();
		expect(addFolder(store, "s", { primary, folder: f, stops })).toEqual([f]);
		expect(readEnvironment(store, "s").added).toEqual([f]);
		expect(removeFolder(store, "s", f)).toEqual([]);
	});

	it("refuses the primary, duplicates, nesting either way, a stop path and a non-folder", () => {
		const { store, primary } = world();
		const f = dir();
		const stop = dir();
		const stops = [stop];
		addFolder(store, "s", { primary, folder: f, stops });
		mkdirSync(join(f, "in"));
		mkdirSync(join(primary, "in"));
		mkdirSync(join(stop, "in"));
		writeFileSync(join(primary, "file"), "");
		for (const folder of [primary, f, join(f, "in"), join(primary, "in"), join(f, ".."), stop, join(stop, "in"), join(primary, "file"), join(primary, "nope")]) {
			expect(() => addFolder(store, "s", { primary, folder, stops }), folder).toThrow(EnvironmentRefusedError);
		}
	});

	it("a damaged or unknown-version file honours nothing and is never overwritten", () => {
		const { store, primary, stops } = world();
		for (const body of ["{not json", JSON.stringify({ version: 2, added: ["/x"] }), JSON.stringify({ version: 1, added: ["relative"] })]) {
			writeFileSync(join(store, environmentFile("s")), body);
			expect(readEnvironment(store, "s")).toEqual({ added: [], damaged: true });
			expect(() => addFolder(store, "s", { primary, folder: dir(), stops })).toThrow(EnvironmentRefusedError);
			expect(readFileSync(join(store, environmentFile("s")), "utf8")).toBe(body);
		}
	});

	it("a stale lock from a crash does not block a change, and the lock is released", () => {
		const { store, primary, stops } = world();
		const path = join(store, environmentFile("s"));
		writeFileSync(`${path}.lock`, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${path}.lock`, old, old);
		addFolder(store, "s", { primary, folder: dir(), stops });
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("two processes adding at once keep both", async () => {
		const { store, primary } = world();
		const folders = Array.from({ length: 12 }, dir);
		const module = new URL("../dist/environment.js", import.meta.url).href;
		const run = (mine: readonly string[]) =>
			new Promise<number>((resolve) => {
				const code = `import(${JSON.stringify(module)}).then((m) => { for (const folder of ${JSON.stringify(mine)}) m.addFolder(${JSON.stringify(store)}, "s", { primary: ${JSON.stringify(primary)}, folder, stops: [] }); })`;
				spawn(process.execPath, ["-e", code], { stdio: "inherit" }).on("exit", (c) => resolve(c ?? 1));
			});
		expect(await Promise.all([run(folders.slice(0, 6)), run(folders.slice(6))])).toEqual([0, 0]);
		expect([...readEnvironment(store, "s").added].sort()).toEqual([...folders].sort());
	});

	it("a fork takes the current list, from a reply before the add too", () => {
		const { store, primary, stops } = world();
		const line = (seq: number, event: object) => `${JSON.stringify({ runId: "r", event: { seq, ...event } })}\n`;
		writeFileSync(join(store, "p.jsonl"), line(0, { type: "user_input", content: "hi" }) + line(1, { type: "terminal", outcome: { kind: "complete" } }));
		const f = dir();
		addFolder(store, "p", { primary, folder: f, stops });
		const { id } = forkSession(store, "p", 1);
		expect(readEnvironment(store, id).added).toEqual([f]);
	});
});
