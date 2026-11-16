import type { ReactNode } from "react";
import type { WorkRow } from "../../shared/history.js";
import type { EnvReply } from "../../shared/settings.js";
import { ago, t } from "../i18n/index.js";

/**
 * The line above a Work's first run: a fork's origin ("Forked from <parent> · when. Files are shared."), or, ADR-0062, the
 * Work that started it ("Started from <parent> · <folder>"); a fork's refusal in the Work it was asked in. Moved out of App.
 */
export function Lead({ env, rows, activeKey, forkError, open }: {
	readonly env: EnvReply | null;
	readonly rows: readonly WorkRow[];
	readonly activeKey: string;
	readonly forkError: string | null;
	readonly open: (sessionId: string) => void;
}): ReactNode {
	if (forkError !== null) return <div className="forknote err" data-kind="fork-error">{forkError}</div>;
	const parentOf = (id: string): WorkRow | undefined => rows.find((w) => w.id === id && w.key === activeKey);
	if (env?.started !== undefined) {
		const parent = parentOf(env.started.parent);
		return (
			<div className="startnote" data-kind="started-from">
				{t.startedFrom}{" "}
				{parent === undefined ? <b>{t.untitled}</b> : <button className="flink" data-act="started-parent" onClick={() => open(env.started!.parent)}>{parent.title || t.untitled}</button>}
				{" · "}
				{env.started.folder}
			</div>
		);
	}
	if (env?.fork === undefined) return null;
	const parentRow = parentOf(env.fork.parent);
	return (
		<div className="forknote" data-kind="fork-note">
			{t.forkedFrom}{" "}
			{parentRow === undefined ? (
				<b data-field="fork-parent-gone">{env.fork.title || t.untitled}</b>
			) : (
				<button className="flink" data-act="fork-parent" onClick={() => open(env.fork!.parent)}>
					{parentRow.title || env.fork.title || t.untitled}
				</button>
			)}{" "}
			· {ago(env.fork.at, Date.now())}. {t.forkShared}
		</div>
	);
}
