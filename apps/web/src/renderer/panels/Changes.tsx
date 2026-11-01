import type { ReactNode } from "react";
import { t } from "../i18n/index.js";
import type { State } from "../state/model.js";
import { changesOf, type Change } from "../state/panels.js";

/** The files the latest run changed, each as the lines added and removed (from the edit and write calls on the log). */
export function Changes({ state, root }: { readonly state: State; readonly root: string | null }): ReactNode {
	const changes = changesOf(state, root);
	if (changes.length === 0) return <div className="empty">{t.noChanges}</div>;
	return (
		<div data-panel-body="diff">
			{changes.map((c) => (
				<ChangeView key={c.path} c={c} />
			))}
			<div className="pnote">{t.changesNote}</div>
		</div>
	);
}

/** One file's change: its path, whether the run created it, and the lines added and removed. */
export function ChangeView({ c }: { readonly c: Change }): ReactNode {
	return (
		<div className="diff" data-change={c.path}>
			<div className="h">
				{c.path}
				{c.created ? ` · ${t.created}` : ""}
				{"  "}
				{c.exact ? `+${c.added} −${c.removed}` : t.deltaModified}
			</div>
			{c.lines.map((l, i) => (
				<div key={i} className={l.kind === "add" ? "a" : l.kind === "del" ? "d" : ""}>
					{`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`}
				</div>
			))}
		</div>
	);
}
