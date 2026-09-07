#!/usr/bin/env node
/** The SURROGATE ARM's trajectory: a kiso FauxScript that applies a task's
 *  reference solution through kiso's own tools — a real kiso process, real
 *  tool execution, a real durable log and a real approval surface, with the
 *  model replaced by a playbook (KISO_FAUX_SCRIPT). It exists so the driver,
 *  the overlays and the record can be exercised for free; it proves the
 *  apparatus, never an agent.
 *
 *  Shape per reference file: an existing file is READ (one turn) and then
 *  WRITTEN citing the revision the read issued (the WR-1 guard; the revision
 *  is sha256 of the seed bytes, so the playbook can cite it); a new file is
 *  written with expectedRevision "absent"; a deletion runs `rm` through the
 *  shell tool, which the declared policy puts at ASK — the surrogate's
 *  approval surface, exercised for free.
 *  usage: faux-script.mjs <task> [--out <file>]   (prints JSON to stdout otherwise) */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lh1 = join(here, "..", "..");
const task = process.argv[2];
if (!task) {
	console.error("usage: faux-script.mjs <task> [--out <file>]");
	process.exit(2);
}
const taskDir = join(lh1, "tasks", task);
const seed = join(taskDir, "workspace");
const ref = join(taskDir, "reference");
const rev = (bytes) => `rev:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

const files = [];
const walk = (dir) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "_DELETE") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else files.push(relative(ref, p));
	}
};
walk(ref);
files.sort();
const deletions = existsSync(join(ref, "_DELETE")) ? readFileSync(join(ref, "_DELETE"), "utf8").split("\n").filter(Boolean) : [];

const turns = [];
let n = 0;
const call = (name, input) => ({ type: "tool_call_end", callId: `s${(n += 1)}`, name, input });
const toolTurn = (text, ...calls) => turns.push({ events: [{ type: "text_delta", text }, ...calls, { type: "stop", reason: "tool_use" }] });
toolTurn("Let me look at the project first.", call("list_dir", {}));
toolTurn("Reading the specification.", call("read_file", { path: existsSync(join(seed, "SPEC.md")) ? "SPEC.md" : "README.md" }));
// the world-observable steps: one reference file per write turn
const steps = [];
const madeDirs = new Set();
for (const rel of files) {
	const content = readFileSync(join(ref, rel), "utf8");
	const seedPath = join(seed, rel);
	// LH1-D2 (recorded by the second free leg): write_file does not create a
	// missing parent directory — it fails with the raw ENOENT. A real agent
	// reacts to that result; a playbook cannot, so the directory is made
	// first, through the shell tool (an ASK in the declared policy).
	const dir = dirname(rel);
	if (dir !== "." && !existsSync(join(seed, dir)) && !madeDirs.has(dir)) {
		madeDirs.add(dir);
		toolTurn(`Creating the ${dir}/ directory.`, call("shell", { command: `mkdir -p -- ${JSON.stringify(dir)}` }));
	}
	if (existsSync(seedPath) && statSync(seedPath).isFile()) {
		toolTurn(`Reading ${rel} before changing it.`, call("read_file", { path: rel }));
		toolTurn(`Rewriting ${rel}.`, call("write_file", { path: rel, content, expectedRevision: rev(readFileSync(seedPath)) }));
		steps.push({ op: "write", path: rel, kind: "modified" });
	} else {
		toolTurn(`Creating ${rel}.`, call("write_file", { path: rel, content, expectedRevision: "absent" }));
		steps.push({ op: "write", path: rel, kind: "new" });
	}
}
for (const rel of deletions) {
	toolTurn(`Removing ${rel}, which the new layout replaces.`, call("shell", { command: `rm -- ${JSON.stringify(rel)}` }));
	steps.push({ op: "delete", path: rel });
}
toolTurn("Running the suite.", call("shell", { command: "npm test --silent" }));
turns.push({ events: [{ type: "text_delta", text: `Done. Applied ${steps.length} changes and ran the tests.` }, { type: "stop", reason: "end_turn" }] });

const outIdx = process.argv.indexOf("--out");
const json = `${JSON.stringify(turns, null, 1)}\n`;
if (outIdx !== -1 && process.argv[outIdx + 1]) {
	writeFileSync(process.argv[outIdx + 1], json);
	writeFileSync(`${process.argv[outIdx + 1]}.steps.json`, `${JSON.stringify(steps, null, 1)}\n`);
	console.log(`[lh1:faux-script] ${task}: ${turns.length} turns, ${steps.length} world steps → ${process.argv[outIdx + 1]}`);
} else process.stdout.write(json);
