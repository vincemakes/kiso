/**
 * kiso-tui — the PURE terminal layer, extracted from the CLI (the
 * ADR-0041 escape hatch). Zero runtime dependencies: input is data,
 * output is bytes. TUI v6 (ADR-0046): the ONE compositor (the single
 * writer — body.ts + dock.ts retired), the component tree, the raw-mode
 * editor, the diff renderer, and the palette.
 */

export { Body, Dock, CURSOR_MARKER, type BodyOptions } from "./compositor.js";
export { Container, foldLine, visibleWidth, SPINNER, type Component, type FrameCtx } from "./components.js";
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
	type RenderInput,
	type RenderResult,
	type RunUsage,
} from "./render.js";
export { editFileDiff, truncateDiff, writeFileDiff, type DiffLine, type DiffResult } from "./diff.js";
