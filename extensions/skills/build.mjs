/**
 * ⑤ — the artifact IS the source: src/kiso-skills.mjs is plain ESM with
 * zero runtime dependencies. "Build" is a copy to dist/ (subagent-style):
 * the user copies dist/kiso-skills.mjs into ~/.kiso/extensions/.
 */
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/kiso-skills.mjs", "dist/kiso-skills.mjs");
