// The preview's address rule and the dev-server discovery, from the page's own module: only http on localhost or 127.0.0.1,
// no credentials, never the app's own host; and what the changes panel derives from a run's edit and write calls.
import { checker } from "./lib.mjs";
import { changesOf, discoverUrls, previewUrl } from "../../dist/renderer/state/panels.js";

const { check, verdict } = checker("panels");
const own = "47123";
const yes = ["localhost:5173", "http://localhost:5173/app?x=1", "127.0.0.1:3000/", "http://127.0.0.1:8080/a#b", "localhost"];
const no = ["https://localhost:5173", "http://example.com", "http://localhost.evil.com:5173", "http://127.0.0.1.evil.com:80", "http://evil.com/#localhost:5173", "http://user:pw@localhost:5173", "http://user@127.0.0.1:5173", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "http://0.0.0.0:5173", "http://[::1]:5173", "http://192.168.1.5:3000", `http://localhost:${own}/`, `127.0.0.1:${own}`, "", "not a url at all"];
check(yes.every((u) => previewUrl(u, own) !== null), `accepted: ${yes.length} local addresses`);
const leaked = no.filter((u) => previewUrl(u, own) !== null);
check(leaked.length === 0, `refused: ${no.length} others (https, other hosts and look-alikes, credentials, other schemes, this app's own port)${leaked.length ? ` — leaked ${JSON.stringify(leaked)}` : ""}`);
check(JSON.stringify(discoverUrls(["  VITE ready", "  Local:   http://localhost:5173/", "  Network: http://192.168.1.5:5173/", "see http://127.0.0.1:3000/docs, and https://x.com", `http://localhost:${own}/`, "http://localhost:5173/"], own)) === JSON.stringify(["http://localhost:5173/", "http://127.0.0.1:3000/docs"]), "a dev server's address is found in command output: local only, once, never this app's own");
const step = (id, name, input, status = "done") => ({ kind: "step", id, name, input, status });
const state = { turns: [{ items: [
	step("1", "edit_file", { path: "/work/README.md", edits: [{ oldText: "a\nb\nc", newText: "a\nB" }] }),
	{ ...step("2", "write_file", { path: "notes.txt", content: "one\ntwo" }), output: { created: true } },
	step("6", "write_file", { path: "old.txt", content: "x" }),
	step("3", "edit_file", { path: "README.md", edits: [{ oldText: "a", newText: "A" }] }),
	step("4", "edit_file", { path: "skipped.md", edits: [] }, "denied"),
	step("5", "shell", { command: "ls" }),
] }] };
const changes = changesOf(state, "/work");
check(changes.map((c) => c.path).join() === "README.md,notes.txt,old.txt" && changes[0].added === 2 && changes[0].removed === 3 && changes[1].created && changes[1].exact && changes[1].added === 2 && !changes[2].created && !changes[2].exact, "the run's changes: each written file once with its added and removed lines; a write over a file is not counted as exact; a denied or a shell step is no change");
verdict();
