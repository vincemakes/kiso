/**
 * kiso-tui — the PURE terminal layer, extracted from the CLI (the
 * escape hatch of ADR-0043, which supersedes ADR-0041). Zero runtime
 * dependencies: input is data,
 * output is bytes. TUI v6 (ADR-0046): the ONE compositor (the single
 * writer — body.ts + dock.ts retired), the component tree, the raw-mode
 * editor, the diff renderer, and the palette.
 */

export { Body, Dock, CURSOR_MARKER, type BodyOptions } from "./compositor.js";
// W21 (the v8 approval round): the approval panel — the bounded block
// that replaces the running tool's live window while a human-chain
// approval is pending (the shape authority is the committed preview).
export {
	panelAffordance,
	panelBlockRows,
	panelLead,
	panelLeadPlain,
	panelLeadWidth,
	panelStatus,
	// TUI2-R2 ④: the pick payload — the panel slot's third occupant.
	PICK_MAX,
	modelPickView,
	pickAffordance,
	pickBlockRows,
	pickLeadPlain,
	type PickOption,
	type PickResult,
	type PickRuntime,
	type PickSpec,
	type PanelArgs,
	type PanelFlavor,
	type PanelPhase,
	deletionRiskHint,
	panelOptions,
	type PanelOption,
	type PanelOptionKind,
	type PanelState,
	type PanelVerdict,
	type PanelView,
} from "./approval-panel.js";
export { Container, foldLine, foldWords, visibleWidth, SPINNER, type Component, type FrameCtx } from "./components.js";
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
	renderResumeList,
	renderSessionLine,
	renderStatusLine,
	relativeTime,
	renderTerminalGap,
	renderToolSummary,
	TAGLINE,
	toolTarget,
	truncateRow,
	type Palette,
	type PathResolver,
	type RecapStats,
	type ResumeMeta,
	type RenderInput,
	type RenderResult,
	type RunUsage,
} from "./render.js";
export { editFileDiff, truncateDiff, writeFileDiff, type DiffLine, type DiffResult } from "./diff.js";
// KC2 §5: the status rows' formatters — the CLI keeps the state and the
// repaint, the terminal layer owns what the row says.
export { STATUS_GLYPHS, cacheHitPct, idleStatus, runningStatus, type StatusMeter } from "./status.js";
// TUI2-R1 (E): /context's attribution rows — a pure function of the
// counts the trace sidecar already records (the CLI reads, this renders).
export { contextRows, contextUnavailableRows, type ContextLedger } from "./context-ledger.js";
// KC3 §1 (the extraction): the human-facing strings — the prompt, the
// project-trust listing/view/note, the uncertain execution's view. The
// FLOW (who is asked, what a verdict means) stays in the cli.
export { interactivePrompt, projectTrustRows, projectTrustView, projectUntrustedNote, uncertainView, type TrustArtifact } from "./strings.js";
// KC3 §3/§5: the @ file picker's pure half — the subsequence filter, the
// deterministic rank, and the ONE cap the CLI's file source shares.
export { AT_CAP, AT_SKIP, AT_VISIBLE, atEmbed, atFilter, atPanelRows, atWindow, bandHeader, longestRun, type AtItem, type AtMatch } from "./at-picker.js";
// TUI2-R2 ①–③: the session picker's pure half — the durability badge,
// the row (picked or printed), the band, and the filter. The CARDS are
// the cli's projection (session-cards.ts); this turns them into bytes.
export {
	BADGE_GLYPH,
	idColumn,
	sessionAge,
	sessionBadge,
	sessionCounterRow,
	sessionFilter,
	sessionListFooter,
	sessionListRow,
	sessionNote,
	sessionPickerRows,
	sessionRow,
	type SessionCardView,
	type SessionPickState,
} from "./session-picker.js";
// KC3.5 (the ask round): the ask view — the panel machinery generalized.
// The cli composes the view and hands the answers to the tool; the keys,
// the rows and the walk are the terminal layer's.
export {
	ASK_HEADER_CAP,
	ASK_MAX_OPTIONS,
	ASK_MAX_QUESTIONS,
	ASK_MIN_OPTIONS,
	askAffordance,
	askAnswers,
	askBlockRows,
	askCommitCustom,
	askDeclineAll,
	askDeclineList,
	askKey,
	askLeadPlain,
	askStart,
	askStatus,
	askView,
	type AskAnswer,
	type AskOption,
	type AskQuestion,
	type AskResult,
	type AskRuntime,
	type AskSpec,
	type AskStep,
} from "./ask-panel.js";
// KC3.5 §4: the interrupted-ask copy — the SAME uncertainty gate, said
// honestly for a question nobody answered (the ① probe's surface).
// TUI2-R1 (D): the keys sheet + THE key table — one source for the ?
// overlay and /help's keys row.
export { KEY_BINDINGS, PANEL_KEYS_ROW, displayVerb, extensionsBannerText, helpRows, keysHelpRow, keysSheetRows, unansweredAskView, type BannerExtension, type KeyBinding } from "./strings.js";
