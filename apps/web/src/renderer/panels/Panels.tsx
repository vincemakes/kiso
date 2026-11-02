import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { fetchTree } from "../state/api.js";
import type { State } from "../state/model.js";
import type { PanelKind, PanelMode } from "../state/panels.js";
import { Changes } from "./Changes.js";
import { Files } from "./Files.js";
import { Open } from "./Open.js";
import { FileIcon } from "../stream/links.js";
import { Preview } from "./Preview.js";
import { COMMANDS, Term } from "./Term.js";
import { I } from "../stream/Icons.js";

interface Props {
	readonly kind: PanelKind;
	readonly mode: PanelMode;
	readonly state: State;
	readonly wkey: string | null;
	readonly sessionId: string;
	readonly focus: string | null;
	readonly sidebarOpen: boolean;
	readonly onFull: () => void;
	readonly onClose: () => void;
}

const NAMES: Readonly<Record<PanelKind, string>> = { term: t.panelTerm, diff: t.panelDiff, web: t.panelWeb, files: t.panelFiles, open: t.panelOpen };

/** The big panel: full height beside the rail, half the Work's width by default, full screen on request. The ⋮ menu that switches panels lives with the rail's keys. */
export function Panels({ kind, mode, state, wkey, sessionId, focus, sidebarOpen, onFull, onClose }: Props): ReactNode {
	const [root, setRoot] = useState<string | null>(null);
	// the folder's real path, to match the paths the run wrote against the tree
	useEffect(() => {
		void fetchTree(wkey, "").then((r) => setRoot(r.root), () => undefined);
	}, [wkey]);
	// tabs of one kind, in the panel's top bar: several pages in the browser (each its own frame, kept while another is shown), one
	// per background task in the terminal plus the run's commands
	const [web, setWeb] = useState<{ readonly tabs: readonly { readonly id: number; readonly url: string | null }[]; readonly on: number }>({ tabs: [{ id: 1, url: kind === "web" ? focus : null }], on: 1 });
	const [termTab, setTermTab] = useState<string>((kind === "term" ? focus : null) ?? state.tasks[0]?.id ?? COMMANDS);
	useEffect(() => {
		if (focus === null) return;
		if (kind === "term") return setTermTab(focus);
		if (kind !== "web") return;
		// an address a link asked for: its tab if one shows it, the empty tab in front, else a new tab
		setWeb((w) => {
			const has = w.tabs.find((x) => x.url === focus);
			if (has !== undefined) return { ...w, on: has.id };
			const front = w.tabs.find((x) => x.id === w.on);
			if (front?.url === null) return { tabs: w.tabs.map((x) => (x.id === w.on ? { ...x, url: focus } : x)), on: w.on };
			const id = Math.max(...w.tabs.map((x) => x.id)) + 1;
			return { tabs: [...w.tabs, { id, url: focus }], on: id };
		});
	}, [kind, focus]);
	const addWeb = (): void => setWeb((w) => ({ tabs: [...w.tabs, { id: Math.max(...w.tabs.map((x) => x.id)) + 1, url: null }], on: Math.max(...w.tabs.map((x) => x.id)) + 1 }));
	const closeWeb = (id: number): void => setWeb((w) => (w.tabs.length === 1 ? w : { tabs: w.tabs.filter((x) => x.id !== id), on: w.on === id ? w.tabs.filter((x) => x.id !== id).at(-1)!.id : w.on }));
	const tabs =
		kind === "web"
			? web.tabs.map((x) => ({ id: String(x.id), label: x.url === null ? t.newTab : x.url.replace(/^https?:\/\//, ""), icon: <I.globe />, on: x.id === web.on, pick: () => setWeb((w) => ({ ...w, on: x.id })), close: web.tabs.length > 1 ? () => closeWeb(x.id) : null }))
			: kind === "term"
				? [...state.tasks.map((x) => ({ id: x.id, label: x.command, icon: <I.term />, on: termTab === x.id, pick: () => setTermTab(x.id), close: null })), { id: COMMANDS, label: t.commandsTab, icon: <I.term />, on: termTab === COMMANDS, pick: () => setTermTab(COMMANDS), close: null }]
				: null;
	return (
		<aside className={`panel ${mode}${mode === "full" && !sidebarOpen ? " clear" : ""}`} data-kind="panel" data-panel={kind}>
			<div className="pv-h">
				{tabs !== null ? (
					<div className="ptabs" role="tablist">
						{tabs.map((x) => (
							<span key={x.id} className={`ptab${x.on ? " on" : ""}`} role="tab" aria-selected={x.on} data-tab={x.id} onClick={x.pick} title={x.label}>
								{x.icon}
								<span>{x.label}</span>
								{x.close !== null ? (
									<button className="ptab-x" aria-label={t.closeTab} data-act="tab-close" onClick={(e) => (e.stopPropagation(), x.close?.())}>
										<I.close />
									</button>
								) : null}
							</span>
						))}
						{kind === "web" ? (
							<button className="sbtn" aria-label={t.newTab} title={t.newTab} onClick={addWeb} data-act="tab-new">
								<I.plus />
							</button>
						) : null}
					</div>
				) : kind === "open" && focus !== null ? (
					<span className="name" title={focus}>
						{/* an image a tool returned has no file name: it is named as such */}
						<FileIcon path={focus.startsWith("log:") ? "image.png" : focus} />
						{focus.startsWith("log:") ? t.imageResult : focus}
					</span>
				) : (
					<span className="name">{NAMES[kind]}</span>
				)}
				<button className="sbtn" onClick={onFull} aria-label={t.panelFull} data-act="panel-full">
					<svg className="ico" viewBox="0 0 24 24">
						<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
					</svg>
				</button>
				<button className="sbtn" onClick={onClose} aria-label={t.panelClose} data-act="panel-close">
					<svg className="ico" viewBox="0 0 24 24">
						<path d="M6 6l12 12M18 6 6 18" />
					</svg>
				</button>
			</div>
			<div className={`pv-b${kind === "web" ? " flush" : ""}`}>
				{kind === "diff" ? <Changes state={state} root={root} /> : null}
				{kind === "files" ? <Files state={state} wkey={wkey} root={root} onRoot={setRoot} /> : null}
				{kind === "term" ? <Term state={state} wkey={wkey} sessionId={sessionId} tab={termTab} /> : null}
				{kind === "web"
					? web.tabs.map((x, i) => (
							<div key={x.id} className="tabpane" style={{ display: x.id === web.on ? "flex" : "none" }} data-pane={x.id}>
								<Preview state={state} focus={x.url} auto={i === 0} onNav={(url) => setWeb((w) => ({ ...w, tabs: w.tabs.map((y) => (y.id === x.id ? { ...y, url } : y)) }))} />
							</div>
						))
					: null}
				{/* another file replaces the one open, with its own modes */}
				{kind === "open" && focus !== null ? <Open key={focus} state={state} wkey={wkey} root={root} path={focus} /> : null}
			</div>
		</aside>
	);
}
