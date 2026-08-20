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
	foldWords,
	visibleWidth,
	bodySpacing,
	Container,
	cellComponent,
	focusToken,
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
	deletionRiskHint,
	SAFER_BACK,
	SAFER_DEGRADED,
	type SaferOption,
	type SaferRuntime,
	panelOptions,
	type PanelOption,
	type PanelOptionKind,
	type PanelState,
	type PanelVerdict,
	type PanelView,
	// KC3.5: the ask shapes both layers agree on (the renderer and the
	// key routing are the tui's; the flow stays in the cli).
	type AskAnswer,
	type AskOption,
	type AskQuestion,
	type AskResult,
	type AskRuntime,
	type AskSpec,
} from "./approval-panel.js";
// KC3 slice 1 (the extraction): the human-facing strings the CLI's
// trust-ui.ts used to build inline — the prompt, the project-trust
// listing/view/note, the uncertain execution's view. The flow stays in
// the cli; what the human reads is presentation.
export {
	interactivePrompt,
	projectTrustRows,
	projectTrustView,
	projectUntrustedNote,
	uncertainView,
	type TrustArtifact,
} from "./strings.js";
// KC3.5: the interrupted-ask copy and the extracted /help table.
export { extensionsBannerText, helpRows, unansweredAskView, type BannerExtension } from "./strings.js";
// TUI2-R2pre ④: the ONE display-verb table — the screen names the act,
// the tool table names the call.
export { displayVerb } from "./strings.js";
export {
	bannerLines,
	COLOR_OFF,
	COLOR_ON,
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
