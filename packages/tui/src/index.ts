/**
 * kiso-tui — the PURE terminal layer, extracted from the CLI (the
 * ADR-0041 escape hatch). Zero runtime dependencies: input is data,
 * output is bytes. The cell renderer (body), the bottom-anchored dock,
 * the raw-mode editor, the diff renderer, and the palette.
 */

export { Body, type BodyOptions } from "./body.js";
export { Dock } from "./dock.js";
export {
	Editor,
	MENU_ITEMS,
	PROMPT,
	PROMPT_WIDTH,
	displayWidth,
	charWidth,
	widthOf,
	type MenuItem,
} from "./editor.js";
export {
	bannerLines,
	COLOR_OFF,
	COLOR_ON,
	escapeTerminal,
	foldResult,
	foldThinking,
	kUnit,
	palette,
	renderEvent,
	renderRecap,
	renderSessionLine,
	renderStatusLine,
	renderTerminalGap,
	renderToolSummary,
	TAGLINE,
	truncateRow,
	type Palette,
	type PathResolver,
	type RecapStats,
	type RenderResult,
	type RunUsage,
} from "./render.js";
export { editFileDiff, truncateDiff, writeFileDiff, type DiffLine, type DiffResult } from "./diff.js";
