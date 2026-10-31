import { useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { groupWorks } from "../state/works.js";
import type { WorkRow } from "../../shared/history.js";
import { Chevron, Plus, Sliders } from "../stream/Icons.js";

interface Props {
	readonly works: readonly WorkRow[];
	/** the open Work: row identity is the folder's key (null: the folder in use) and the session id */
	readonly active: { readonly key: string; readonly id: string } | null;
	readonly settingsOn: boolean;
	readonly onOpen: (row: WorkRow) => void;
	readonly onNew: () => void;
	readonly onSettings: () => void;
}

/** The history, newest first by day, and the Functions fold at the bottom (v1: Settings). The toggle and the push-right live in the shell. */
export function Sidebar({ works, active, settingsOn, onOpen, onNew, onSettings }: Props): ReactNode {
	const [fold, setFold] = useState(false);
	return (
		<aside className="side" data-kind="sidebar">
			<div className="side-in">
			<button className="newbtn" onClick={onNew} data-act="new">
				<Plus />
				{t.newTask}
			</button>
			<div className="hlist">
				{groupWorks(works).map((group) => (
					<section key={group.label}>
						<div className="grp">{group.label}</div>
						{group.works.map((row) => (
							<button key={`${row.key}/${row.id}`} className={`item${active?.key === row.key && active.id === row.id ? " on" : ""}`} onClick={() => onOpen(row)} data-work={row.id} data-state={row.state}>
								{row.state === "running" ? <span className="sp" title={t.runningNow} /> : row.state === "waiting" ? <span className="dot amber" title={t.waitingForYou} /> : null}
								<span className="tt">{row.title === "" ? t.untitled : row.title}</span>
								<small>{row.folder}</small>
							</button>
						))}
					</section>
				))}
			</div>
			<div className={`fn${fold ? " open" : ""}`}>
				<button className="fn-h" onClick={() => setFold(!fold)} aria-expanded={fold}>
					{t.functions}
					<span className="chev">
						<Chevron />
					</span>
				</button>
				<div className="fn-b">
					<div>
						<button className={settingsOn ? "on" : ""} onClick={onSettings} data-act="settings">
							<Sliders />
							{t.settings}
						</button>
					</div>
				</div>
			</div>
			</div>
		</aside>
	);
}
