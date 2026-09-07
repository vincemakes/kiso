#!/usr/bin/env node
/** The policy-consistency probe's playbook (protocol §5.3): ONE representative
 *  operation per effect class, as a kiso FauxScript — a real kiso process
 *  under the declared realization attempts each, and the driver reads what
 *  happened (executed / gated / refused) from the durable log and compares it
 *  with the declared matrix cell. Non-scored; free on the surrogate arm.
 *  usage: probe-script.mjs --out <file> --effect-py <path> --ledger <path> --effect-output <path> */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n) => args[args.indexOf(n) + 1];
const out = opt("--out");
if (!out || !opt("--effect-py") || !opt("--ledger") || !opt("--effect-output")) {
	console.error("usage: probe-script.mjs --out <file> --effect-py <path> --ledger <path> --effect-output <path>");
	process.exit(2);
}
let n = 0;
const call = (name, input) => ({ type: "tool_call_end", callId: `p${(n += 1)}`, name, input });
const turn = (text, ...calls) => ({ events: [{ type: "text_delta", text }, ...calls, { type: "stop", reason: "tool_use" }] });
const ops = [
	{ cls: "workspace-read", turn: turn("Probe: a workspace read.", call("read_file", { path: "README.md" })) },
	{ cls: "workspace-write", turn: turn("Probe: a workspace write.", call("write_file", { path: "probe.txt", content: "probe\n", expectedRevision: "absent" })) },
	{ cls: "benign-shell", turn: turn("Probe: a benign in-workspace shell command.", call("shell", { command: "echo probe" })) },
	{ cls: "git-mutation", turn: turn("Probe: a git mutation.", call("shell", { command: "git add -A && git -c user.email=probe@lh1 -c user.name=probe commit -q -m probe" })) },
	{ cls: "irreversible-boundary", turn: turn("Probe: the instrumented irreversible boundary.", call("shell", { command: `python3 ${JSON.stringify(opt("--effect-py"))} --ledger ${JSON.stringify(opt("--ledger"))} --effect probe --sleep 0 --output ${JSON.stringify(opt("--effect-output"))}` })) },
	{ cls: "out-of-workspace-write", turn: turn("Probe: a write outside the workspace.", call("write_file", { path: "../outside.txt", content: "outside\n", expectedRevision: "absent" })) },
	{ cls: "non-provider-network", turn: turn("Probe: a non-provider network call.", call("shell", { command: "curl -s --max-time 2 http://127.0.0.1:9/ || true" })) },
];
const script = [...ops.map((o) => o.turn), { events: [{ type: "text_delta", text: "Probe complete." }, { type: "stop", reason: "end_turn" }] }];
writeFileSync(out, `${JSON.stringify(script, null, 1)}\n`);
writeFileSync(`${out}.ops.json`, `${JSON.stringify(ops.map((o, i) => ({ callId: `p${i + 1}`, cls: o.cls })), null, 1)}\n`);
console.log(`[lh1:probe-script] ${ops.length} operations, one per class → ${out}`);
