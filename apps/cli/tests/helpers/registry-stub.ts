/**
 * A registry stub that can answer while `ptyRun` is running.
 *
 * THE TRAP THIS EXISTS FOR: `ptyRun` uses `spawnSync`, which blocks the
 * calling process's event loop for the whole session. An `http.Server`
 * created in the test process therefore cannot accept a connection while
 * the CLI is up — every request the CLI makes appears, from its side, as
 * a server that never answers.
 *
 * That is not merely inconvenient. A gate written against an in-process
 * stub passes for the WRONG REASON: "the slow stub" and "the silent
 * stub" become the same experiment, and a first-frame comparison across
 * them is guaranteed to succeed whether the product is correct or not.
 * Both update-line gates were written that way and one of them was green
 * on nothing.
 *
 * So the stub is a SEPARATE PROCESS. It writes its port to a file, and
 * the caller waits for that file with synchronous reads — no event loop
 * needed on either side.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StubMode = "ok" | "slow" | "silent";

export interface RegistryStub {
	/** the endpoint to hand the CLI as KISO_UPDATE_ENDPOINT */
	readonly url: string;
	/** how many requests the stub has received so far */
	hits(): number;
	stop(): void;
}

/** ESM, because the repo root's package.json is `"type": "module"` and
 *  `node -e` takes its module kind from the nearest one — a `require`
 *  here dies before the server ever listens. */
const SOURCE = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
// via the ENVIRONMENT, not argv: with \`node -e\` there is no script path,
// so argv has no stable offset to slice from and the first real argument
// is silently eaten.
const { STUB_PORT_FILE: portFile, STUB_HIT_FILE: hitFile, STUB_MODE: mode, STUB_LATEST: latest } = process.env;
let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  try { writeFileSync(hitFile, String(hits)); } catch {}
  if (mode === "silent") return;                       // never answers
  const send = () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ latest }));
  };
  if (mode === "slow") setTimeout(send, 10000); else send();
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
`;

/** Start the stub and block until it is listening. */
export function startRegistryStub(mode: StubMode = "ok", latest = "99.0.0"): RegistryStub {
	const dir = mkdtempSync(join(tmpdir(), "kiso-stub-"));
	const portFile = join(dir, "port");
	const hitFile = join(dir, "hits");
	const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", SOURCE], {
		stdio: "ignore",
		env: { ...process.env, STUB_PORT_FILE: portFile, STUB_HIT_FILE: hitFile, STUB_MODE: mode, STUB_LATEST: latest },
	});
	// synchronous wait: the caller is about to block on spawnSync anyway,
	// and an await here would be a promise nobody can settle later.
	const deadline = Date.now() + 10_000;
	while (!existsSync(portFile)) {
		if (Date.now() > deadline) {
			child.kill("SIGKILL");
			throw new Error("registry stub did not start");
		}
		// a tight spin is fine for a few milliseconds and needs no timer
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	const port = readFileSync(portFile, "utf8").trim();
	return {
		url: `http://127.0.0.1:${port}/dist-tags`,
		hits: () => (existsSync(hitFile) ? Number(readFileSync(hitFile, "utf8").trim()) : 0),
		stop: () => {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
