import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tsc emits renderer.js; the page itself is not TypeScript
const to = fileURLToPath(new URL("../dist/renderer/", import.meta.url));
mkdirSync(to, { recursive: true });
copyFileSync(fileURLToPath(new URL("../src/renderer/index.html", import.meta.url)), `${to}index.html`);
