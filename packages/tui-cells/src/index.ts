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
// W22 (the v8 input round): the pending-queue chips — the SAME
// UserMessage chip with the □ gutter, pre-rendered above the input
// row while turns wait in the queue.
export { pendingQueueRows } from "./components.js";
export { charWidth, displayWidth, leadWidth, widthOf } from "./width.js";
// W21 (the v8 approval round): the approval panel — the bounded block
// that replaces the running tool's live window while a human-chain
// approval is pending. Types + the row/lead/status renderers; the
// verdict mapping lives in the cli, never here.
export {
	panelAffordance,
	panelBlockRows,
	panelLead,
	panelLeadPlain,
	panelLeadWidth,
	panelStatus,
	type PanelArgs,
	type PanelFlavor,
	type PanelPhase,
	type PanelSel,
	type PanelState,
	type PanelVerdict,
	type PanelView,
} from "./approval-panel.js";
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
