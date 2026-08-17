/**
 * KC3.5 — the artifact IS the source: src/kiso-ask.mjs is plain ESM with
 * zero runtime dependencies. "Build" is a copy to dist/, the same
 * consumption story the other official extensions ship (the built-in
 * layer imports the package; a user may copy dist/kiso-ask.mjs into
 * ~/.kiso/extensions/ to shadow it).
 */
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/kiso-ask.mjs", "dist/kiso-ask.mjs");
