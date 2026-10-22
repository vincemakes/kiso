// The page the host serves: it prints the stream through kiso-client, the
// same typed client a Node script uses. The token rides the URL fragment
// (never sent to a server) and is removed from the address once read.
import { createClient } from "/vendor/client/index.js";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token");
const session = params.get("session") ?? "desktop-spike";
const auto = params.get("input");
history.replaceState(null, "", location.pathname);

const log = document.getElementById("log");
const out = (cls, text) => {
	const line = document.createElement("span");
	line.className = cls;
	line.textContent = `${text}\n`;
	log.append(line);
	window.__kisoLines = (window.__kisoLines ?? 0) + 1;
};

const client = createClient({ baseUrl: `${location.origin}/v1/sessions`, headers: () => ({ authorization: `Bearer ${token}` }) });
const s = client.session(session);
window.__kiso = { events: [], frames: [], done: false };

async function run(input) {
	window.__kiso.done = false;
	for await (const ev of s.runStream(input)) {
		if (ev.kind === "event") {
			window.__kiso.events.push(ev.event);
			const e = ev.event;
			out("wire", `${e.seq} ${e.type}${e.text !== undefined ? ` ${JSON.stringify(e.text)}` : ""}${e.name !== undefined ? ` ${e.name}` : ""}`);
		} else if (ev.kind === "frame") {
			window.__kiso.frames.push({ event: ev.event, data: ev.data });
			out("frame", `frame ${ev.event} ${JSON.stringify(ev.data).slice(0, 160)}`);
		}
	}
	window.__kiso.done = true;
	out("wire", "-- stream ended");
}
window.__kisoRun = run;

document.getElementById("f").addEventListener("submit", (e) => {
	e.preventDefault();
	const box = document.getElementById("input");
	void run(box.value);
	box.value = "";
});
if (auto !== null && token !== null) void run(auto);
