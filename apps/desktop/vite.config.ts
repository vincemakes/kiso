import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The renderer: bundled into out/renderer, which the host serves. */
export default defineConfig({
	root: "src/renderer",
	plugins: [react()],
	build: { outDir: "../../out/renderer", emptyOutDir: true, target: "chrome140", sourcemap: false },
});
