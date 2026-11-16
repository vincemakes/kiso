// Size, layout and weight gate (plan section 4). Reads tracked files, so `git add` new files first.
//   per-directory line budgets, 400 lines per file, no new top-level folder, no image, video or HTML mock in the tree
//   (the icon and the web manifest in resources/ excepted, 500 KB for all of it), no build output.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// src/main is 3,940 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 6, rewind); it was 3,930. src/renderer is 7,570 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 6, rewind); it was 7,540. src/main is 3,930 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 7, ask_user in the web); it was 3,920. src/renderer is 7,540 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 7, ask_user in the web); it was 7,430. src/renderer is 7,430 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 5b, S3 and S4); it was 7,400. src/main is 3,920, src/renderer 7,400 and scripts/proofs 3,980 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 5a, the message rows); they were 3,880, 7,230 and 3,880. src/main is 3,880, src/renderer 7,230 and scripts/proofs 3,880 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 4, start_session and its cards); they were 3,740, 7,100 and 3,780. src/main is 3,740 and scripts/proofs 3,780 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 3, the wake budget, the completion wake and the hold); they were 3,680 and 3,700. src/main is 3,680 and scripts/proofs 3,700 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 2, the inbox and message); they were 3,620 and 3,630. src/main is 3,620 and scripts/proofs 3,630 from 2026-11-16 (owner ruling 2026-11-16: ADR-0062 PR 1, addressing and list_sessions); they were 3,500 and 3,560. src/renderer is 7,100 from 2026-11-14 (owner ruling 2026-11-14: the waiting steer with copy, take-back and Send now, and the wake turn); it was 7,000. scripts/proofs is 3,560 from 2026-11-12 (owner ruling 2026-11-12: the task-name proofs of #449 and the composer's); it was 3,500. src/renderer is 7,000 from 2026-11-11 (owner ruling 2026-11-11: the Work cache, reading position, unsent line and skeleton, with room for small fixes); it was 6,800. src/main is 3,500 and scripts/proofs 3,500 from 2026-11-11 (owner ruling 2026-11-11: main was left over by #433 and #442 landing together; room for the Work cache stack); they were 3,450 and 3,400. scripts/proofs is 3,400 from 2026-11-11 (owner ruling 2026-11-11: #428, #433, #434, #437, #438 and the :(exclude) test); it was 3,300 the same day. src/renderer is 6,800, src/main 3,450 and scripts/proofs was 3,300 from 2026-11-11 (owner ruling 2026-11-11: the Environment page, with room for later small fixes; scripts/proofs 3,200 -> 3,300 the same day, owner ruling 2026-11-11: room for #428, #433 and 0.54's fixes); they were 6,560 (the reconnect indicator's ruling, 2026-11-11; 6,500 before), 3,300 and 3,100. scripts/proofs is 3,100 from 2026-11-10 (owner ruling: "can go to 3100", the UI audit's fixes each carry a proof); it was 3,000 from the sidebar plan's PR C on (owner ruling 2026-11-04: "the web proofs can have some budget"); it was 2,900 before and 2,800 from the sidebar menu plan on (owner ruling 2026-11-02: its proof and the sidebar rebuild's); src/main is 3,100 from the fork plan on (owner ruling 2026-11-02: the fork door, its lineage and its notice); scripts/proofs was 2,600 and src/main 2,800 from the rail and composer plan on (owner ruling 2026-11-02: the rail, composer and git proofs, the task-stop, git and PR doors); scripts/proofs was 2,100 from W1c (owner ruling 2026-11-01, W1c stream, chips and artifact proofs); it was 1,800 from W1b (owner ruling 2026-10-31, W1b stream proofs), 1,600 from S5 (owner ruling 2026-10-26, S5); it was 1,300 from S4 (owner ruling 2026-10-25, S4), 1,000 from S2 (owner ruling 2026-10-23, S2) and 700 before. src/main was 2,500 before; the other budgets are unchanged.
const BUDGETS = { "src/main": 3940, "src/shared": 400, "src/renderer": 7570, "scripts/gates": 800, "scripts/proofs": 3980 };
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
