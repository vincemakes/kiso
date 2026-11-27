#!/usr/bin/env node
/**
 * The negative corpus, kept honest (the kiso-secrets spec § 4): findSecret
 * runs over EVERY tracked text file and must find nothing outside the
 * package's own tests. A hit is either a real secret (remove it) or a false
 * positive (a pattern too wide — fix the pattern by evidence, never by an
 * allowlist entry for the file).
 *
 * One exemption, by kind and not by file: in TEST files an `assignment` hit
 * is a named test value (an api key a test names as a stand-in, which it must
 * name). Every key-FORMAT kind (provider, cloud, GitHub, Slack, Google, JWT,
 * PEM, URL credentials) is still a failure in a test file.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findSecret } from "../packages/secrets/dist/index.js";

const ALLOW = [/^packages\/secrets\/tests\//];
const TEST_FILE = /(^|\/)tests?\/|\.test\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$/;
const files = execSync("git ls-files -z", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
const hits = [];
let scanned = 0;
for (const f of files) {
	if (ALLOW.some((re) => re.test(f))) continue;
	let buf;
	try { buf = readFileSync(f); } catch { continue; }
	if (buf.includes(0)) continue; // binary
	scanned += 1;
	const text = buf.toString("utf8");
	let offset = 0;
	for (let m = findSecret(text); m !== null; m = findSecret(text.slice(offset))) {
		const at = offset + m.start;
		if (!(m.kind === "assignment" && TEST_FILE.test(f))) hits.push(`${f}:${text.slice(0, at).split("\n").length}: ${m.kind}`);
		offset = offset + m.end;
		if (offset >= text.length) break;
	}
}
if (hits.length) {
	console.error(`[check-secrets] ${hits.length} hit(s) in tracked files:\n  ${hits.join("\n  ")}`);
	process.exit(1);
}
console.log(`[check-secrets] OK — ${scanned} tracked text files, no secret shapes outside packages/secrets/tests`);
