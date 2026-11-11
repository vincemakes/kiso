// What the Environment rows read from a log and a folder, without a browser: a shell call whose arguments did not parse (input null) reads as
// no command; a cd or a `gh pr create` counts only in a line that is one && chain; the pull request is the LAST URL the command printed; a
// folder's GitHub remote is origin's, else another GitHub one; an added folder's @ listing never names what the file tools refuse there.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker } from "./lib.mjs";
import { environmentRows, scanLog } from "../../dist/main/environment.js";
import { githubOf } from "../../dist/main/folder-info.js";
import { atFiles } from "../../dist/main/fs-routes.js";

const { check, verdict } = checker("env-log");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kiso-web-envlog-")));
const call = (id, input, out = "", isError = false) => [{ type: "tool_call_end", callId: id, name: "shell", input }, { type: "tool_result", callId: id, isError, content: out }];
const scan = (...calls) => scanLog(calls.flat(), tmp, "/h");
check(scan(call("a", null), call("b", { command: `cd ${tmp} && ls` })).recent.join() === tmp, "a call whose arguments did not parse (input null) is read as no command, and the log is still read");
check(scan(call("a", { command: `false && cd ${tmp} && ls || true` }), call("b", { command: `cd ${tmp}; ls` }), call("c", { command: `cd ${tmp} && ls`, }, "", true)).recent.length === 0, "a cd counts only in a line that is one && chain, and in a call that did not fail");
const pr = (line, out) => scan(call("p", { command: line }, out)).repos.map((r) => `${r.repo}#${r.number}`).join();
check(pr("false && gh pr create --fill || echo https://github.com/a/b/pull/123", "https://github.com/a/b/pull/123") === "" && pr("gh pr create; echo done", "https://github.com/a/b/pull/1") === "", "a gh pr create in a || or ; line makes no row");
check(pr("gh pr create --fill", "see https://github.com/x/y/pull/1\nhttps://github.com/a/b/pull/123") === "a/b#123", "the pull request is the last URL the command printed");
const repo = (name, remotes) => {
	const dir = join(tmp, name);
	mkdirSync(dir);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	for (const [n, u] of remotes) execFileSync("git", ["remote", "add", n, u], { cwd: dir });
	return githubOf(dir);
};
check(repo("one", [["upstream", "https://github.com/up/stream.git"], ["origin", "https://github.com/me/mine.git"]]) === "me/mine" && repo("two", [["origin", "https://example.com/x/y.git"], ["fork", "https://github.com/me/fork.git"]]) === "me/fork" && repo("three", [["origin", "https://example.com/x/y.git"]]) === null, "a folder's GitHub remote is origin's, else another GitHub one, else none");
const root = join(tmp, "added");
mkdirSync(join(root, ".ssh"), { recursive: true });
writeFileSync(join(root, ".ssh", "id"), "k");
writeFileSync(join(root, "a.txt"), "x");
const listed = atFiles({ workspace: join(tmp, "one") }, [root], [join(root, ".ssh")]).files;
check(listed.includes(join(root, "a.txt")) && !listed.some((f) => f.includes("/.ssh/")), "an added folder's @ listing leaves out the stop roots");
// an added folder replaced by a symlink is refused by the file tools, so @ must not list the new target's names
const target = join(tmp, "elsewhere");
mkdirSync(target);
writeFileSync(join(target, "secret.txt"), "s");
const swapped = join(tmp, "swapped");
symlinkSync(target, swapped);
check(!atFiles({ workspace: join(tmp, "one") }, [swapped], []).files.some((f) => f.endsWith("secret.txt")), "a root that is no longer its own real path (replaced by a symlink) is not listed");
// the memory is per space AND Work: two folders can hold a Work of the same id with the same last seq
const space = (key, dir) => ({ key, workspace: dir, dir: join(tmp, `d-${key}`), store: { load: () => call("a", { command: `cd ${dir}/sub && ls` }).map((event, i) => ({ event: { ...event, seq: i + 1 } })) } });
const [a, b] = ["x", "y"].map((k) => { const dir = join(tmp, `w-${k}`); mkdirSync(join(dir, "sub"), { recursive: true }); mkdirSync(join(tmp, `d-${k}`)); return space(k, dir); });
const rowsOf = (sp) => environmentRows(sp, "same", undefined).folders.filter((f) => f.kind === "recent").map((f) => f.path).join();
check(rowsOf(a) === join(a.workspace, "sub") && rowsOf(b) === join(b.workspace, "sub") && rowsOf(a) === join(a.workspace, "sub"), "the rows cache is per space and Work: the same id and last seq in two folders keep their own recent folders");
const row0 = environmentRows(a, "same", undefined).folders[0];
check(row0.name === "w-x" && row0.parent === tmp, "a row's name and parent come from the host's path module");
// a note told to one Work is not told to another of the same id in another folder
const { noteFolders, withNote } = await import("../../src/renderer/state/envnote.ts");
noteFolders("k1", "s", "added /a."); noteFolders("k2", "s", "added /b.");
const lead = (w) => withNote(w, "s", "hi")[0]?.text ?? "";
check(lead("k1").endsWith("added /a.") && lead("k2").endsWith("added /b.") && withNote("k1", "s", "hi") === "hi" && withNote(null, "s", "hi") === "hi", "a pending update line is per folder and Work, and is told once");
check(scan(call("p", { command: "gh pr create && echo https://github.com/other/repo/pull/123" }, "https://github.com/a/b/pull/1\nhttps://github.com/other/repo/pull/123")).repos.length === 0, "a pull request counts only from a line that ends in gh pr create");
verdict();
