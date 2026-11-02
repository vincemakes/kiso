import { useEffect, useState, type ReactNode } from "react";
import type { EnvReply } from "../../shared/settings.js";
import { t } from "../i18n/index.js";
import { fetchRecent } from "../state/desk.js";

interface Props {
	readonly env: EnvReply | null;
	/** choose a folder with the system's dialog */
	readonly onPick: () => void;
	/** a folder from the recent list */
	readonly onOpen: (path: string) => void;
}

/** Under the input box: the folder this Work runs in (a click chooses another). The tier is the composer's own pill. */
export function Tray({ env, onPick, onOpen }: Props): ReactNode {
	const [menu, setMenu] = useState(false);
	const [recent, setRecent] = useState<readonly { readonly folder: string; readonly path: string }[]>([]);
	useEffect(() => {
		if (!menu) return;
		void fetchRecent().then((r) => setRecent(r.recent), () => undefined);
		const close = (): void => setMenu(false);
		addEventListener("click", close);
		return () => removeEventListener("click", close);
	}, [menu]);
	return (
		<div className="tray" data-kind="tray">
			<div className="trayfold">
				<button
					className="chip"
					title={t.folderTip}
					data-act="folder"
					onClick={(e) => {
						e.stopPropagation();
						setMenu(!menu);
					}}
				>
					<svg className="ico" viewBox="0 0 24 24">
						<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
					</svg>
					<span data-field="folder">{env?.folder ?? ""}</span>
				</button>
				{menu ? (
					<div className="menu fmenu" data-kind="folder-menu">
						<button onClick={onPick} data-act="pick">
							{t.folderChoose}
						</button>
						{recent.length > 0 ? <div className="mlabel">{t.folderRecent}</div> : null}
						{recent.map((r) => (
							<button key={r.path} onClick={() => onOpen(r.path)} data-recent={r.path} title={r.path}>
								{r.folder}
							</button>
						))}
					</div>
				) : null}
			</div>
			<span className="hint">{"⌘K"}</span>
		</div>
	);
}
