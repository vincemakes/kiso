// Size, layout and weight gate (plan section 4). Reads tracked files, so `git add` new files first.
//   per-directory line budgets, 400 lines per file, no new top-level folder, no image, video or HTML mock in the tree
//   (the icon and the web manifest in resources/ excepted, 500 KB for all of it), no build output.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

<<<<<<< HEAD
<<<<<<< HEAD
// src/renderer is 6,560 from 2026-11-11 (owner ruling: the reconnect indicator, its line, state and Send gate); it was 6,500 before. scripts/proofs is 3,100 from 2026-11-10 (owner ruling: "can go to 3100", the UI audit's fixes each carry a proof); it was 3,000 from the sidebar plan's PR C on (owner ruling 2026-11-04: "the web proofs can have some budget"); it was 2,900 before and 2,800 from the sidebar menu plan on (owner ruling 2026-11-02: its proof and the sidebar rebuild's); src/main is 3,100 from the fork plan on (owner ruling 2026-11-02: the fork door, its lineage and its notice); scripts/proofs was 2,600 and src/main 2,800 from the rail and composer plan on (owner ruling 2026-11-02: the rail, composer and git proofs, the task-stop, git and PR doors); scripts/proofs was 2,100 from W1c (owner ruling 2026-11-01, W1c stream, chips and artifact proofs); it was 1,800 from W1b (owner ruling 2026-10-31, W1b stream proofs), 1,600 from S5 (owner ruling 2026-10-26, S5); it was 1,300 from S4 (owner ruling 2026-10-25, S4), 1,000 from S2 (owner ruling 2026-10-23, S2) and 700 before. src/main was 2,500 before; the other budgets are unchanged.
const BUDGETS = { "src/main": 3300, "src/shared": 400, "src/renderer": 6560, "scripts/gates": 800, "scripts/proofs": 3100 };
=======
// src/renderer is 6,800, src/main 3,450 and scripts/proofs 3,200 from 2026-11-11 (owner ruling 2026-11-11: the Environment page, with room for later small fixes); they were 6,500, 3,300 and 3,100. scripts/proofs is 3,100 from 2026-11-10 (owner ruling: "can go to 3100", the UI audit's fixes each carry a proof); it was 3,000 from the sidebar plan's PR C on (owner ruling 2026-11-04: "the web proofs can have some budget"); it was 2,900 before and 2,800 from the sidebar menu plan on (owner ruling 2026-11-02: its proof and the sidebar rebuild's); src/main is 3,100 from the fork plan on (owner ruling 2026-11-02: the fork door, its lineage and its notice); scripts/proofs was 2,600 and src/main 2,800 from the rail and composer plan on (owner ruling 2026-11-02: the rail, composer and git proofs, the task-stop, git and PR doors); scripts/proofs was 2,100 from W1c (owner ruling 2026-11-01, W1c stream, chips and artifact proofs); it was 1,800 from W1b (owner ruling 2026-10-31, W1b stream proofs), 1,600 from S5 (owner ruling 2026-10-26, S5); it was 1,300 from S4 (owner ruling 2026-10-25, S4), 1,000 from S2 (owner ruling 2026-10-23, S2) and 700 before. src/main was 2,500 before; the other budgets are unchanged.
const BUDGETS = { "src/main": 3450, "src/shared": 400, "src/renderer": 6800, "scripts/gates": 800, "scripts/proofs": 3200 };
>>>>>>> 47f55661 (chore(web): size budgets for the Environment page (owner ruling 2026-11-11))
=======
// src/renderer is 6,800, src/main 3,450 and scripts/proofs 3,300 from 2026-11-11 (owner ruling 2026-11-11: the Environment page, with room for later small fixes; scripts/proofs 3,200 -> 3,300 the same day, owner ruling 2026-11-11: room for #428, #433 and 0.54's fixes); they were 6,500, 3,300 and 3,100. scripts/proofs is 3,100 from 2026-11-10 (owner ruling: "can go to 3100", the UI audit's fixes each carry a proof); it was 3,000 from the sidebar plan's PR C on (owner ruling 2026-11-04: "the web proofs can have some budget"); it was 2,900 before and 2,800 from the sidebar menu plan on (owner ruling 2026-11-02: its proof and the sidebar rebuild's); src/main is 3,100 from the fork plan on (owner ruling 2026-11-02: the fork door, its lineage and its notice); scripts/proofs was 2,600 and src/main 2,800 from the rail and composer plan on (owner ruling 2026-11-02: the rail, composer and git proofs, the task-stop, git and PR doors); scripts/proofs was 2,100 from W1c (owner ruling 2026-11-01, W1c stream, chips and artifact proofs); it was 1,800 from W1b (owner ruling 2026-10-31, W1b stream proofs), 1,600 from S5 (owner ruling 2026-10-26, S5); it was 1,300 from S4 (owner ruling 2026-10-25, S4), 1,000 from S2 (owner ruling 2026-10-23, S2) and 700 before. src/main was 2,500 before; the other budgets are unchanged.
const BUDGETS = { "src/main": 3450, "src/shared": 400, "src/renderer": 6800, "scripts/gates": 800, "scripts/proofs": 3300 };
>>>>>>> 62e83614 (chore(web): scripts/proofs budget 3200 -> 3300 (owner ruling 2026-11-11))
const FILE_CAP = 400;
const TOP = new Set([".gitignore", "DEPS.md", "LICENSE", "README.md", "package.json", "resources", "scripts", "src", "tsconfig.build.json", "tsconfig.json", "vite.config.ts"]);
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
