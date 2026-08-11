/**
 * R-D 0.1.45 (deliverable B) — the first-run scaffold. A fresh install's
 * FIRST startup materializes the config surface (the file the faux-mode
 * notice names) and stamps the sentinel that ends first-run.
 *
 * Runs AFTER the E3 trust gate: pre-trust zero-read/write/scan is
 * absolute — the trust question is the process's first home access of
 * any kind, the trust record the first home write, the scaffold the
 * second. First-run detection never precedes the verdict.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kisoHome } from "./state.js";

/** The sentinel: present = the home has seen the 0.1.45 first-run
 *  sequence (its config surface exists — no re-scaffold, no re-note). */
const SENTINEL = "first-run";

/** The minimal config surface — an empty models layer changes nothing
 *  (faux stays the default), but the file the notice points at exists. */
const CONFIG_SCAFFOLD = `${JSON.stringify({ models: {} }, null, 2)}\n`;

/** First-run detection. Called only post-gate, so the verdict precedes
 *  even the first home READ. */
export function isFirstRun(): boolean {
	return !existsSync(join(kisoHome(), SENTINEL));
}

/** Materialize the config surface (never clobbering a user's own config)
 *  and stamp the sentinel — the sequence's second home write. SILENT on
 *  purpose: every stream line must match a known cell format (the v2d
 *  lint), and the PTY grids pin the startup stream byte-for-byte — the
 *  first-run sequence is evidenced by the FILES, not an announcement. */
export function scaffoldFirstRun(): void {
	const home = kisoHome();
	mkdirSync(home, { recursive: true });
	const config = join(home, "config.json");
	if (!existsSync(config)) writeFileSync(config, CONFIG_SCAFFOLD, "utf8");
	writeFileSync(join(home, SENTINEL), "", "utf8");
}
