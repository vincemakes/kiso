// What a command made, found without a guess: a path named in the command or its output counts only if it is inside the folder,
// is an artifact type, exists, and changed during the step. A command that writes a file without naming it finds nothing (and is
// no error); an old file named in the output is not taken; nor is a file named outside the folder or in a dot-directory. A write
// of an artifact type is one; of another type is not.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker } from "./lib.mjs";

const { check, verdict } = checker("shell-artifacts");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const workspace = scratch("sa-ws");
const outside = scratch("sa-out");
mkdirSync(join(workspace, ".cache"));
writeFileSync(join(workspace, "old.html"), "<title>Old</title>");
utimesSync(join(workspace, "old.html"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
writeFileSync(join(workspace, "make.js"), "require('fs').writeFileSync('quiet.png', 'x');\n");
const script = [
	{ events: [
		call("c1", "shell", { command: "printf '<title>Out</title>' > out.html && echo wrote out.html" }),
		call("c2", "shell", { command: "node make.js" }),
		call("c3", "shell", { command: `touch .cache/x.png ${outside}/far.png && echo see old.html .cache/x.png ${outside}/far.png` }),
		call("c4", "write_file", { path: "page.html", content: "<title>Page</title>" }),
		call("c5", "write_file", { path: "notes.txt", content: "plain" }),
		{ type: "stop", reason: "tool_use" },
	] },
	{ events: [{ type: "text_delta", text: "Done." }, { type: "stop", reason: "end_turn" }] },
];
const host = await launch({ data: scratch("sa-data"), workspace, fauxScript: script, env: { KISO_WEB_MODE: "full-access" } });
const frames = [];
for await (const ev of clientFor(host).session("sa").runStream("make things")) if (ev.kind === "frame" && ev.event === "tool_output") frames.push(ev.data);
host.child.kill("SIGTERM");
const of = (id) => frames.find((f) => f.callId === id);
const uris = (id) => (of(id)?.artifacts ?? []).map((a) => `${a.kind} ${a.uri}`).join();
check(uris("c1") === "page file:out.html" && of("c1").artifacts[0].workId === "sa" && of("c1").artifacts[0].callId === "c1", `a command that writes out.html and prints its path: found, tied to its call and Work (${uris("c1")})`);
check(uris("c2") === "" && !of("c2").isError, "a command that writes quiet.png without naming it: nothing found, and no error");
check(uris("c3") === "" && !of("c3").isError && of("c3").head.join().includes("far.png"), `an old file named in the output, a file in a dot-directory and one outside the folder, all named and touched: none taken (${uris("c3")})`);
check(uris("c4") === "page file:page.html" && uris("c5") === "", `a write of a page is an artifact; of a .txt is not (${uris("c4")} | ${uris("c5")})`);
verdict();
