/**
 * kiso-tui-cells — the components cell renderer, extracted from the
 * tui (ADR-0043 Amendment 4): components.ts, diff.ts, width.ts, and
 * the render slice. ZERO runtime dependencies: input is data, output
 * is bytes. The tui is the stable consumer (its shims re-export this
 * package); the cli never imports it directly. Experimental — no
 * API-stability promise yet.
 */

export {
	SPINNER,
	foldLine,
	visibleWidth,
	bodySpacing,
	Container,
	cellComponent,
	ROLLUP_NOUN,
	turnFold,
	CAP_TASK_LIVE,
	formatDuration,
	statusLine,
	boxTop,
	boxBottom,
	terminalPipe,
	type FrameCtx,
	type RenderLine,
	type Component,
	type BodyCell,
} from "./components.js";
export { editFileDiff, truncateDiff, writeFileDiff, type DiffLine, type DiffResult } from "./diff.js";
export { charWidth, displayWidth, widthOf } from "./width.js";
export {
	bannerLines,
	COLOR_OFF,
	COLOR_ON,
	colorInlineCode,
	escapeTerminal,
	foldResult,
	foldThinking,
	kUnit,
	palette,
	relativeTime,
	renderResumeList,
	renderTerminalGap,
	renderToolSummary,
	TAGLINE,
	toolTarget,
	truncateRow,
	type Palette,
	type ResumeMeta,
} from "./render.js";
