// The page the host serves: it prints the stream through kiso-client, the
// same typed client a Node script uses. The token rides the URL fragment
// (never sent to a server) and is removed from the address once read.
import type { WireEvent } from "@vincemakes/kiso-protocol";
import { createClient } from "/vendor/client/index.js";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? "";
const session = params.get("session") ?? "desktop-spike";
const auto = params.get("input");
history.replaceState(null, "", location.pathname);

const log = document.getElementById("log")!;
const out = (cls: string, text: string): void => {
	console.log(text); // the Electron main forwards the page console to its stdout
	const line = document.createElement("span");
	line.className = cls;
	line.textContent = `${text}\n`;
	log.append(line);
	};

const client = createClient({ baseUrl: `${location.origin}/v1/sessions`, headers: () => ({ authorization: `Bearer ${token}` }) });
const s = client.session(session);
interface Probe {
	events: WireEvent[];
	frames: { event: string; data: unknown }[];
	done: boolean;
}
const probe: Probe = { events: [], frames: [], done: false };
(window as unknown as { __kiso: Probe }).__kiso = probe; // read by the spike through the debugging port

async function run(input: string): Promise<void> {
	probe.done = false;
	for await (const ev of s.runStream(input)) {
		if (ev.kind === "event") {
			probe.events.push(ev.event);
			const e = ev.event as WireEvent & { text?: string; name?: string };
			out("wire", `${e.seq} ${e.type}${e.text !== undefined ? ` ${JSON.stringify(e.text)}` : ""}${e.name !== undefined ? ` ${e.name}` : ""}`);
		} else if (ev.kind === "frame") {
			probe.frames.push({ event: ev.event, data: ev.data });
			out("frame", `frame ${ev.event} ${JSON.stringify(ev.data).slice(0, 160)}`);
		}
	}
	probe.done = true;
	out("wire", "-- stream ended");
}

document.getElementById("f")!.addEventListener("submit", (e) => {
	e.preventDefault();
	const box = document.getElementById("input") as HTMLInputElement;
	void run(box.value);
	box.value = "";
});
if (auto !== null && token !== null) void run(auto);
