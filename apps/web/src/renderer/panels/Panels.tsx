import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { fetchTree } from "../state/api.js";
import type { State } from "../state/model.js";
import type { PanelKind, PanelMode } from "../state/panels.js";
import { Changes } from "./Changes.js";
import { Files } from "./Files.js";
import { Preview } from "./Preview.js";
import { Term } from "./Term.js";

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

const NAMES: Readonly<Record<PanelKind, string>> = { term: t.panelTerm, diff: t.panelDiff, web: t.panelWeb, files: t.panelFiles };

/** The big panel: full height beside the rail, half the Work's width by default, full screen on request. The ⋮ menu that switches panels lives with the rail's keys. */
export function Panels({ kind, mode, state, wkey, sessionId, focus, sidebarOpen, onFull, onClose }: Props): ReactNode {
	const [root, setRoot] = useState<string | null>(null);
	// the folder's real path, to match the paths the run wrote against the tree
	useEffect(() => {
		void fetchTree(wkey, "").then((r) => setRoot(r.root), () => undefined);
	}, [wkey]);
	return (
		<aside className={`panel ${mode}${mode === "full" && !sidebarOpen ? " clear" : ""}`} data-kind="panel" data-panel={kind}>
			<div className="pv-h">
				<span className="name">{NAMES[kind]}</span>
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
				{kind === "term" ? <Term state={state} wkey={wkey} sessionId={sessionId} focus={focus} /> : null}
				{kind === "web" ? <Preview state={state} /> : null}
			</div>
		</aside>
	);
}
