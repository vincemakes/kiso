// bundles src/index.ts -> dist/kiso-program.mjs (research). The core and the sandbox's WebAssembly
// package stay external: the bundle is not yet self-contained (see the research notes).
import { build } from "esbuild";
await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "node", target: "node22", format: "esm", outfile: "dist/kiso-program.mjs", external: ["@vincemakes/kiso-core", "quickjs-wasi", "quickjs-wasi/*"], logLevel: "warning" });
