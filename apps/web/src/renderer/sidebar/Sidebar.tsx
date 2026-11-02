import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import { groupWorks } from "../state/works.js";
import type { WorkRow } from "../../shared/history.js";
import { Chevron, Plus, Sliders } from "../stream/Icons.js";
import { Dialog } from "../rail/GitDialogs.js";

export type WorkAct = "pin" | "unpin" | "archive" | "unarchive" | "delete";

interface Props {
	readonly works: readonly WorkRow[];
	/** the open Work: row identity is the folder's key (null: the folder in use) and the session id */
	readonly active: { readonly key: string; readonly id: string } | null;
	readonly settingsOn: boolean;
	readonly onOpen: (row: WorkRow) => void;
	readonly onNew: () => void;
	readonly onSettings: () => void;
	/** a row's menu: each refusal comes back in words */
	readonly onAct: (row: WorkRow, act: WorkAct) => Promise<void>;
	readonly onRename: (row: WorkRow, name: string) => Promise<void>;
	readonly onFork: (row: WorkRow) => void;
	/** the open pull request of the row's folder branch, read when its menu opens */
	readonly prOf: (row: WorkRow) => Promise<{ readonly number: number; readonly url: string } | null>;
}

const svg = (d: ReactNode): ReactNode => (
	<svg className="ico" viewBox="0 0 24 24">
		{d}
	</svg>
);
const PIN = <path d="M9 4h6l-1 6 4 4H6l4-4-1-6zM12 14v6" />;
const ICONS = {
	pin: PIN,
	rename: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
	fork: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" /></>,
	pr: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2" /></>,
	archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
	trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />,
};

/** A row's ⋯ menu, laid over the window at the key (the list scrolls, the menu does not clip): a click away or Esc closes it. */
function WorkMenu({ row, at, onClose, onPick, prOf }: { readonly row: WorkRow; readonly at: DOMRect; readonly onClose: () => void; readonly onPick: (what: WorkAct | "rename" | "fork" | "pr", pr?: string) => void; readonly prOf: Props["prOf"] }): ReactNode {
	const box = useRef<HTMLDivElement>(null);
	const [pr, setPr] = useState<{ readonly number: number; readonly url: string } | null>(null);
	useEffect(() => void prOf(row).then(setPr, () => undefined), [row, prOf]);
	useEffect(() => {
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) === false && onClose());
		const key = (e: KeyboardEvent): void => void (e.key === "Escape" && onClose());
		addEventListener("mousedown", away);
		addEventListener("keydown", key);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
	}, [onClose]);
	const item = (what: WorkAct | "rename" | "fork" | "pr", icon: ReactNode, label: string, danger = false): ReactNode => (
		<button className={danger ? "danger" : ""} data-menu-act={what} onClick={() => onPick(what, pr?.url)}>
			{svg(icon)}
			{label}
		</button>
	);
	return (
		<div ref={box} className="menu smenu" data-kind="work-menu" style={{ top: Math.min(at.bottom + 2, innerHeight - 290), left: at.right - 34 }}>
			{item(row.pinned !== undefined ? "unpin" : "pin", ICONS.pin, row.pinned !== undefined ? t.unpin : t.pin)}
			{item("rename", ICONS.rename, t.rename)}
			{row.runs > 0 ? item("fork", ICONS.fork, t.fork) : null}
			{pr !== null ? item("pr", ICONS.pr, fmt(t.openPr, { n: pr.number })) : null}
			<div className="sep" />
			{item(row.archived === true ? "unarchive" : "archive", ICONS.archive, row.archived === true ? t.unarchive : t.archive)}
			{item("delete", ICONS.trash, t.deleteWork, true)}
		</div>
	);
}

/** The history: pinned first, then by day; a row's ⋯ menu; the Archived line; the Functions fold at the bottom (v1: Settings). */
export function Sidebar({ works, active, settingsOn, onOpen, onNew, onSettings, onAct, onRename, onFork, prOf }: Props): ReactNode {
	const [fold, setFold] = useState(false);
	const [menu, setMenu] = useState<{ readonly row: WorkRow; readonly at: DOMRect } | null>(null);
	const [renaming, setRenaming] = useState<WorkRow | null>(null);
	const [draft, setDraft] = useState("");
	const [deleting, setDeleting] = useState<WorkRow | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const box = useRef<HTMLInputElement>(null);
	const same = (a: WorkRow | null, b: WorkRow): boolean => a !== null && a.key === b.key && a.id === b.id;
	const act = (row: WorkRow, what: WorkAct): void => void onAct(row, what).then(() => setError(null), (e: Error) => setError(e.message));
	const pick = (row: WorkRow, what: WorkAct | "rename" | "fork" | "pr", pr?: string): void => {
		setMenu(null);
		if (what === "rename") {
			setDraft(row.title);
			setRenaming(row);
			requestAnimationFrame(() => box.current?.select());
		} else if (what === "fork") onFork(row);
		else if (what === "pr") open(pr, "_blank", "noopener");
		else if (what === "delete") (setError(null), setDeleting(row));
		else act(row, what);
	};
	const keep = (row: WorkRow): void => {
		setRenaming(null);
		if (draft.trim() !== row.title) void onRename(row, draft);
	};
	const rowOf = (row: WorkRow, className: string): ReactNode => (
		<div key={`${row.key}/${row.id}`} className={`row${same(menu?.row ?? null, row) ? " menu-open" : ""}`}>
			{same(renaming, row) ? (
				<div className={`item ${className}`}>
					<input
						ref={box}
						className="row-in"
						value={draft}
						maxLength={120}
						aria-label={t.renameWork}
						data-field="row-title-input"
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) keep(row);
							else if (e.key === "Escape") setRenaming(null);
						}}
						onBlur={() => setRenaming(null)}
					/>
				</div>
			) : (
				<button className={`item ${className}${active?.key === row.key && active.id === row.id ? " on" : ""}`} onClick={() => onOpen(row)} data-work={row.id} data-state={row.state}>
					{row.state === "running" ? <span className="sp" title={t.runningNow} /> : row.state === "waiting" ? <span className="dot amber" title={t.waitingForYou} /> : null}
					<span className="tt">{row.title === "" ? t.untitled : row.title}</span>
					{row.pinned !== undefined ? <span className="pinmark" title={t.pinned}>{svg(PIN)}</span> : null}
					<small>{row.folder}</small>
				</button>
			)}
			{same(renaming, row) ? null : (
				<button className="dots" aria-label={t.workMenu} data-act="work-menu" data-for={row.id} onClick={(e) => setMenu(same(menu?.row ?? null, row) ? null : { row, at: e.currentTarget.closest(".row")!.getBoundingClientRect() })}>
					{svg(<><circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18.5" cy="12" r="1.2" /></>)}
				</button>
			)}
		</div>
	);
	const archived = works.filter((w) => w.archived === true);
	return (
		<aside className="side" data-kind="sidebar">
			<div className="side-in">
			<button className="newbtn" onClick={onNew} data-act="new">
				<Plus />
				{t.newTask}
			</button>
			<div className="hlist">
				{error !== null && deleting === null ? <div className="side-err" data-kind="work-error">{error}</div> : null}
				{groupWorks(works).map((group) => (
					<section key={group.label}>
						<div className="grp">{group.label}</div>
						{group.works.map((row, i) => rowOf(row, row.parent !== undefined && row.pinned === undefined && group.works.some((w) => w.key === row.key && w.id === row.parent) ? (group.works[i + 1]?.parent === row.parent ? "child more" : "child") : ""))}
					</section>
				))}
				{archived.length > 0 ? (
					<section>
						<button className="grp archived-h" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived} data-act="archived">
							{fmt(t.archivedN, { n: archived.length })}
						</button>
						{showArchived ? archived.map((row) => rowOf(row, "")) : null}
					</section>
				) : null}
			</div>
			{menu !== null ? <WorkMenu row={menu.row} at={menu.at} onClose={() => setMenu(null)} onPick={(what, pr) => pick(menu.row, what, pr)} prOf={prOf} /> : null}
			{deleting !== null ? (
				<Dialog
					kind="delete"
					title={fmt(t.deleteTitle, { title: deleting.title === "" ? t.untitled : deleting.title })}
					sub={deleting.folder}
					busy={busy}
					error={error}
					confirm={t.deleteConfirm}
					danger
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						setBusy(true);
						void onAct(deleting, "delete").then(
							() => (setBusy(false), setDeleting(null), setError(null)),
							(e: Error) => (setBusy(false), setError(e.message)),
						);
					}}
				>
					<p className="dlg-p" data-kind="delete-what">{fmt(t.deleteWhat, { runs: deleting.runs === 1 ? t.oneRun : fmt(t.nRuns, { n: deleting.runs }) })}</p>
				</Dialog>
			) : null}
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
