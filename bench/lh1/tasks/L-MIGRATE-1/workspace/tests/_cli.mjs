import { spawnSync } from "node:child_process";

/** Run the CLI black-box from the project root. */
export function lintr(...args) {
	const r = spawnSync(process.execPath, ["src/cli.mjs", ...args], { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
