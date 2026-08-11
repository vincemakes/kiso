/**
 * ⑥ — the artifact IS the source: src/kiso-task.mjs is plain ESM with
 * zero runtime dependencies. "Build" is a copy to dist/ (skills-style):
 * the user copies dist/kiso-task.mjs into ~/.kiso/extensions/, and the
 * cli consumes the same artifact as a built-in (R-D 0.1.45, package.json
 * exports → dist).
 */
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/kiso-task.mjs", "dist/kiso-task.mjs");
