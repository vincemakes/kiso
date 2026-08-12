#!/usr/bin/env node
/**
 * S1 (2026-08-12): the hero gate — README "Using it" ↔ examples/hello-agent.ts.
 *
 * The README's hero block is the ADVERTISED shape (anthropic adapter, real
 * model); the example is its executable form (faux adapter, zero keys —
 * the consumer smoke compiles and runs it in a clean project). The two
 * must be the same code modulo exactly three pinned substitutions, which
 * hero-check applies to the EXAMPLE and compares against the README block:
 *
 *   import { createFauxProvider } from "@vincemakes/kiso-evals";
 *       → import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
 *         import Anthropic from "@anthropic-ai/sdk";
 *   model: "faux"      → model: "claude-sonnet-5"
 *   adapter: createFauxProvider(…)  → adapter: createAnthropicAdapter(new Anthropic()),
 *
 * Any drift in EITHER direction — the README block or the example — is RED.
 * The ritual is the review's sign-off + an edit to both files in the same
 * commit; this gate flips back green.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readLines(rel) {
	return readFileSync(new URL(rel, `file://${ROOT}`), "utf8").replace(/\r\n/g, "\n").split("\n");
}

// The README block: the first ```ts fence after "## Using it".
const readme = readLines("README.md");
const usingIdx = readme.findIndex((l) => l === "## Using it");
if (usingIdx === -1) throw new Error("hero-check: README has no '## Using it' heading");
const fenceStart = readme.findIndex((l, i) => i > usingIdx && l.trim() === "```ts");
if (fenceStart === -1) throw new Error("hero-check: no ```ts fence under '## Using it'");
let fenceEnd = -1;
for (let i = fenceStart + 1; i < readme.length; i++) {
	if (readme[i].trim() === "```") {
		fenceEnd = i;
		break;
	}
}
if (fenceEnd === -1) throw new Error("hero-check: unclosed ```ts fence under '## Using it'");
const block = readme.slice(fenceStart + 1, fenceEnd);

// The example: the runnable hero. A leading //-comment header is meta
// (it names this gate) — stripped before comparison.
const exampleLines = readLines("examples/hello-agent.ts");
let i = 0;
while (i < exampleLines.length && /^\s*\/\//.test(exampleLines[i])) i++;
const example = exampleLines.slice(i);

// The three pinned substitutions (region-exact, so drift shows as a diff).
const out = [];
i = 0;
while (i < example.length) {
	const line = example[i];
	if (line === `import { createFauxProvider } from "@vincemakes/kiso-evals";`) {
		out.push(
			`import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";`,
			`import Anthropic from "@anthropic-ai/sdk";`,
		);
		i++;
		continue;
	}
	if (line === `  model: "faux",`) {
		out.push(`  model: "claude-sonnet-5",`);
		i++;
		continue;
	}
	if (line === `  adapter: createFauxProvider([`) {
		// consume the whole one-line script through the closing `  ]),`
		let j = i + 1;
		while (j < example.length && example[j] !== `  ]),`) j++;
		if (j === example.length) {
			throw new Error("hero-check: the example's faux script never closes with `  ]),`");
		}
		out.push(`  adapter: createAnthropicAdapter(new Anthropic()),`);
		i = j + 1;
		continue;
	}
	out.push(line);
	i++;
}

const norm = (lines) => lines.map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "") + "\n";
const a = norm(block);
const b = norm(out);
if (a === b) {
	console.log('hero-check: README "Using it" block matches examples/hello-agent.ts (modulo the 3 pinned substitutions) — GREEN');
	process.exit(0);
}
console.error("hero-check: README hero drifted from examples/hello-agent.ts — RED");
const al = a.split("\n");
const bl = b.split("\n");
const n = Math.max(al.length, bl.length);
for (let k = 0; k < n; k++) {
	if (al[k] !== bl[k]) {
		console.error(`  first diff at line ${k + 1}:`);
		console.error(`    README:    ${al[k] ?? "(absent)"}`);
		console.error(`    example:   ${bl[k] ?? "(absent)"}`);
		break;
	}
}
process.exit(1);
