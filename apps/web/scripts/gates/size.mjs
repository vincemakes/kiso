// Size, layout and weight gate (plan section 4). Reads tracked files, so `git add` new files first.
//   per-directory line budgets, 400 lines per file, no new top-level folder, no image, video or HTML mock in the tree
//   (the icon and the web manifest in resources/ excepted, 500 KB for all of it), no build output.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// scripts/proofs is 1,800 lines from W1b on (owner ruling 2026-10-31, W1b stream proofs); it was 1,600 from S5 (owner ruling 2026-10-26, S5); it was 1,300 from S4 (owner ruling 2026-10-25, S4), 1,000 from S2 (owner ruling 2026-10-23, S2) and 700 before. The other budgets are unchanged.
const BUDGETS = { "src/main": 2500, "src/shared": 400, "src/renderer": 6500, "scripts/gates": 800, "scripts/proofs": 1800 };
const FILE_CAP = 400;
const TOP = new Set([".gitignore", "DEPS.md", "README.md", "package.json", "resources", "scripts", "src", "tsconfig.build.json", "tsconfig.json", "vite.config.ts"]);
const CODE = /\.(ts|cts|tsx|css|html|mjs)$/;
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|mov|webm|psd|dmg)$/i;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => f !== "");
const problems = [];
const used = Object.fromEntries(Object.keys(BUDGETS).map((d) => [d, 0]));
for (const file of files) {
	const top = file.split("/")[0];
	if (!TOP.has(top)) problems.push(`${file}: a new top-level entry "${top}" needs a plan change`);
	if (/(^|\/)(out|dist)\//.test(file)) problems.push(`${file}: build output is never committed`);
	if (MEDIA.test(file) && !file.startsWith("resources/")) problems.push(`${file}: no image, video or package in the tree outside resources/`);
	if (file.endsWith(".html") && file !== "src/renderer/index.html") problems.push(`${file}: no HTML mock in the tree`);
	if (!CODE.test(file)) continue;
	const lines = readFileSync(file, "utf8").split("\n").length - 1;
	if (lines > FILE_CAP) problems.push(`${file}: ${lines} lines, the cap is ${FILE_CAP}`);
	for (const dir of Object.keys(BUDGETS)) if (file.startsWith(`${dir}/`)) used[dir] += lines;
}
const resources = files.filter((f) => f.startsWith("resources/")).reduce((n, f) => n + statSync(f).size, 0);
if (resources > 500 * 1024) problems.push(`resources/: ${resources} bytes, the budget is 500 KB`);
for (const [dir, budget] of Object.entries(BUDGETS)) if (used[dir] > budget) problems.push(`${dir}: ${used[dir]} lines, the budget is ${budget}`);
if (problems.length > 0) {
	console.error(`[size] ${problems.length} problem(s):\n${problems.join("\n")}`);
	process.exit(1);
}
console.log(`[size] OK: ${Object.entries(used).map(([d, n]) => `${d} ${n}/${BUDGETS[d]}`).join(", ")}`);
