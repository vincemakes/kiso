/**
 * ③ — build the self-contained single-file bundle: dist/kiso-mcp.mjs.
 * The @modelcontextprotocol/sdk and everything it pulls in is inlined;
 * node builtins stay external (platform=node). The file is the artifact
 * the E1 loader imports — drop it into ~/.kiso/extensions/.
 */
import { build } from "esbuild";

await build({
	entryPoints: ["src/index.ts"],
	outfile: "dist/kiso-mcp.mjs",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	// The SDK pulls cross-spawn, a CJS module that calls require() at
	// runtime; in an ESM bundle that require must come from somewhere.
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	logLevel: "warning",
});
