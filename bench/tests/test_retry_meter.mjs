// The retry meter (bench/retry-meter.mjs): a provider 400 is re-sent byte
// for byte and never reaches the client while an attempt remains; three
// refusals in a row reach it; a clean answer is untouched. Every attempt is
// a ledger line, and a re-sent one is marked and carries no usage.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createProxy } from "../retry-meter.mjs";

let calls = 0, refuse = 0;
const bodies = [];
const upstream = http.createServer((req, res) => {
	let b = "";
	req.on("data", (c) => (b += c));
	req.on("end", () => {
		calls += 1;
		bodies.push(b);
		if (calls <= refuse) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end('{"message":"invalid request error trace_id: x","type":"invalid_request_error"}');
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write('data: {"choices":[]}\n\n');
		res.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
	});
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

async function trial(label, refusals) {
	calls = 0; refuse = refusals; bodies.length = 0;
	const out = fs.mkdtempSync(path.join(os.tmpdir(), `retry-meter-${label}-`));
	const { server } = createProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, key: "dummy", out, capUsd: 1 });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const r = await fetch(`http://127.0.0.1:${server.address().port}/t/leg-1/chat/completions`, { method: "POST", body: '{"model":"m","messages":[]}' });
	await r.text();
	server.close();
	const ledger = fs.readFileSync(path.join(out, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	return { status: r.status, calls, ledger, bodies: [...bodies] };
}

const one = await trial("one", 1);
assert.equal(one.status, 200, "one 400 is absorbed");
assert.equal(one.calls, 2);
assert.deepEqual(one.ledger.map((l) => [l.status, !!l.retried, l.usage !== null]), [[400, true, false], [200, false, true]]);
assert.equal(one.bodies[0], one.bodies[1], "the re-send is byte for byte");

const three = await trial("three", 3);
assert.equal(three.status, 400, "the third refusal reaches the client");
assert.equal(three.calls, 3);
assert.deepEqual(three.ledger.map((l) => [l.status, !!l.retried]), [[400, true], [400, true], [400, false]]);

const none = await trial("none", 0);
assert.equal(none.status, 200);
assert.equal(none.calls, 1);
assert.deepEqual(none.ledger.map((l) => [l.status, !!l.retried]), [[200, false]]);

upstream.close();
console.log("test_retry_meter: 3 scenarios OK");
