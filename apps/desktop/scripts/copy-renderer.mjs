import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../src/renderer/", import.meta.url));
const to = fileURLToPath(new URL("../dist/renderer/", import.meta.url));
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
