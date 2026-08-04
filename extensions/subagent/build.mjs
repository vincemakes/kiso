/**
 * ④ — the artifact IS the source: src/kiso-subagent.mjs is plain ESM with
 * zero runtime dependencies (child_process/fs are builtins). "Build" is a
 * copy to dist/ so the consumption story matches the MCP bridge: the user
 * copies dist/kiso-subagent.mjs into ~/.kiso/extensions/.
 */
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/kiso-subagent.mjs", "dist/kiso-subagent.mjs");
