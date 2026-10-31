import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The renderer: bundled into out/renderer, which the host serves; the icon and the web manifest are copied beside it (an installed page's name and icon). */
export default defineConfig({
	root: "src/renderer",
	publicDir: "../../resources",
	plugins: [react()],
	build: { outDir: "../../out/renderer", emptyOutDir: true, target: ["chrome120", "safari17"], sourcemap: false },
});
