import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import { groupWorks } from "../state/works.js";
import type { WorkRow } from "../../shared/history.js";
import { Chevron, Gear, Plus, PullRequest } from "../stream/Icons.js";
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
	/** link the row's Work to a pull request (a URL or a number), or unlink it (null) */
	readonly onLinkPr: (row: WorkRow, pr: string | null) => Promise<void>;
	/** the open pull request of the row's folder branch, read when its menu opens */
	readonly prOf: (row: WorkRow) => Promise<{ readonly number: number; readonly url: string } | null>;
}

const svg = (d: ReactNode): ReactNode => (
	<svg className="ico" viewBox="0 0 24 24">
		{d}
	</svg>
);
/** The menu's items in order, each with its key (pressed while the menu is open); null draws a line. */
const KEYS = { pr: "G", link: "L", unlink: "L", pin: "P", unpin: "P", rename: "R", fork: "F", archive: "A", unarchive: "A", delete: "D" } as const;
type Pick = keyof typeof KEYS;

/** A row's ⋯ menu, laid over the window at the key (the list scrolls, the menu does not clip): a click away or Esc closes it, a
 *  letter picks. */
function WorkMenu({ row, at, onClose, onPick, prOf }: { readonly row: WorkRow; readonly at: DOMRect; readonly onClose: () => void; readonly onPick: (what: Pick, pr?: string) => void; readonly prOf: Props["prOf"] }): ReactNode {
	const box = useRef<HTMLDivElement>(null);
	const [pr, setPr] = useState<{ readonly number: number; readonly url: string } | null>(null);
	// the Work's own PR first; else its folder branch's open one, read when the menu opens
	useEffect(() => void (row.pr === undefined && prOf(row).then(setPr, () => undefined)), [row, prOf]);
	const shown = row.pr ?? pr;
	const items: (readonly [Pick, string, boolean?] | null)[] = [
		...(shown !== null ? [["pr", fmt(t.openPr, { n: shown.number })] as const] : []),
		row.pr !== undefined ? ["unlink", fmt(t.unlinkPr, { n: row.pr.number })] : ["link", t.linkPr],
		null,
		row.pinned !== undefined ? ["unpin", t.unpin] : ["pin", t.pin],
		["rename", t.rename],
		...(row.runs > 0 ? [["fork", t.fork] as const] : []),
		null,
		row.archived === true ? ["unarchive", t.unarchive] : ["archive", t.archive],
		["delete", t.deleteWork, true],
	];
	useEffect(() => {
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) === false && onClose());
		const key = (e: KeyboardEvent): void => {
			if (e.key === "Escape") return onClose();
			const hit = e.metaKey || e.ctrlKey || e.altKey ? undefined : items.find((it) => it !== null && KEYS[it[0]] === e.key.toUpperCase());
			if (hit) (e.preventDefault(), onPick(hit[0], shown?.url));
		};
		addEventListener("mousedown", away);
		addEventListener("keydown", key);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
	});
	return (
		<div ref={box} className="menu smenu" data-kind="work-menu" style={{ top: Math.min(at.bottom + 2, innerHeight - 290), left: at.right - 34 }}>
			{items.map((it, i) =>
				it === null ? (
					<div key={i} className="sep" />
				) : (
					<button key={it[0]} className={it[2] === true ? "danger" : ""} data-menu-act={it[0]} onClick={() => onPick(it[0], shown?.url)}>
						{it[1]}
						<kbd>{KEYS[it[0]]}</kbd>
					</button>
				),
			)}
		</div>
	);
}

/** Which groups (and which rows' nested sessions) are folded, kept per browser (a convenience: it reads back empty when storage is
 *  not there). */
const FOLDS = "kiso.web.folds";
const KID_FOLDS = "kiso.web.kid-folds";
const foldsRead = (key = FOLDS): string[] => {
	try {
		return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
	} catch {
		return [];
	}
};

/** What a row's dot says, by what the person should do: needs you (amber) > working (the ring) > finished unread (blue) > nothing. */
type Dot = "waiting" | "running" | "unread" | "idle";
const RANK: Readonly<Record<Dot, number>> = { waiting: 3, running: 2, unread: 1, idle: 0 };
const stateOf = (row: WorkRow): Dot => (row.state === "idle" && row.unread === true ? "unread" : row.state);
const dotOf = (row: WorkRow): ReactNode => {
	const state = stateOf(row);
	return state === "running" ? <span className="sp" title={t.runningNow} /> : state === "waiting" ? <span className="dot amber" title={t.waitingForYou} /> : state === "unread" ? <span className="dot blue" title={t.unreadNow} data-dot="unread" /> : null;
};

/** The history: pinned first, then Recents; a row's ⋯ menu; the Archived line; Settings at the foot. */
export function Sidebar({ works, active, settingsOn, onOpen, onNew, onSettings, onAct, onRename, onFork, onLinkPr, prOf }: Props): ReactNode {
	const [menu, setMenu] = useState<{ readonly row: WorkRow; readonly at: DOMRect } | null>(null);
	const [renaming, setRenaming] = useState<WorkRow | null>(null);
	const [draft, setDraft] = useState("");
	const [deleting, setDeleting] = useState<WorkRow | null>(null);
	const [linking, setLinking] = useState<WorkRow | null>(null);
	const [prDraft, setPrDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const [folds, setFolds] = useState<readonly string[]>(foldsRead);
	const fold = (label: string): void => {
		const next = folds.includes(label) ? folds.filter((f) => f !== label) : [...folds, label];
		setFolds(next);
		try {
			localStorage.setItem(FOLDS, JSON.stringify(next));
		} catch {}
	};
	const box = useRef<HTMLInputElement>(null);
	const same = (a: WorkRow | null, b: WorkRow): boolean => a !== null && a.key === b.key && a.id === b.id;
	const act = (row: WorkRow, what: WorkAct): void => void onAct(row, what).then(() => setError(null), (e: Error) => setError(e.message));
	const pick = (row: WorkRow, what: Pick, pr?: string): void => {
		setMenu(null);
		if (what === "rename") {
			setDraft(row.title);
			setRenaming(row);
			requestAnimationFrame(() => box.current?.select());
		} else if (what === "fork") onFork(row);
		else if (what === "pr") open(pr, "_blank", "noopener");
		else if (what === "link") (setError(null), setPrDraft(""), setLinking(row));
		else if (what === "unlink") void onLinkPr(row, null).then(() => setError(null), (e: Error) => setError(e.message));
		else if (what === "delete") (setError(null), setDeleting(row));
		else act(row, what);
	};
	const keep = (row: WorkRow): void => {
		setRenaming(null);
		if (draft.trim() !== row.title) void onRename(row, draft);
	};
	const [shutKids, setShutKids] = useState<readonly string[]>(() => foldsRead(KID_FOLDS));
	const foldKids = (row: WorkRow): void => {
		const id = `${row.key}/${row.id}`;
		const next = shutKids.includes(id) ? shutKids.filter((f) => f !== id) : [...shutKids, id];
		setShutKids(next);
		try {
			localStorage.setItem(KID_FOLDS, JSON.stringify(next));
		} catch {}
	};
	const rowOf = (row: WorkRow, className: string, nested: readonly WorkRow[] = []): ReactNode => {
		const shut = nested.length > 0 && shutKids.includes(`${row.key}/${row.id}`);
		// a folded parent shows the most urgent state of itself and what it folds
		const urgent = shut ? [row, ...nested].reduce((a, b) => (RANK[stateOf(b)] > RANK[stateOf(a)] ? b : a)) : row;
		return (
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
					{dotOf(urgent)}
					<span className="tt">{row.title === "" ? t.untitled : row.title}</span>
					{row.pr !== undefined ? (
						<span className="pr-ico" role="link" data-pr-state={row.pr.state?.toLowerCase() ?? "unknown"} title={`${fmt(t.prOf, { n: row.pr.number })}${row.pr.state === undefined ? "" : ` · ${t.prStates.split("|")[["OPEN", "MERGED", "CLOSED"].indexOf(row.pr.state)]}`}`} data-act="row-pr" onClick={(e) => (e.stopPropagation(), open(row.pr!.url, "_blank", "noopener"))}>
							<PullRequest />
						</span>
					) : null}
					{nested.length > 0 ? (
						<span className={`kid-fold${shut ? " shut" : ""}`} role="button" aria-label={t.foldNested} aria-expanded={!shut} data-act="fold-nested" onClick={(e) => (e.stopPropagation(), foldKids(row))}>
							<Chevron />
						</span>
					) : null}
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
	};
	/** Under a folded row: how many sessions it folds, and how many of them finished unread; a click unfolds them. */
	const kidsLine = (row: WorkRow, nested: readonly WorkRow[]): ReactNode => {
		const unread = nested.filter((w) => stateOf(w) === "unread").length;
		return (
			<button key={`${row.key}/${row.id}/kids`} className="kids-line" onClick={() => foldKids(row)} data-act="unfold-nested">
				{nested.length === 1 ? t.nestedOne : fmt(t.nested, { n: nested.length })}
				{unread > 0 ? <em>{` · ${fmt(t.nUnread, { n: unread })}`}</em> : null}
			</button>
		);
	};
	const archived = works.filter((w) => w.archived === true);
	/** A group's rows: a nested session (a fork, under the row it came from) follows its top row, which folds them all. */
	const rowsOf = (rows: readonly WorkRow[]): ReactNode[] => {
		const isChild = (row: WorkRow): boolean => row.parent !== undefined && row.pinned === undefined && rows.some((w) => w.key === row.key && w.id === row.parent);
		const out: ReactNode[] = [];
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]!;
			if (isChild(row)) continue;
			let end = i + 1;
			while (end < rows.length && isChild(rows[end]!)) end++;
			const nested = rows.slice(i + 1, end);
			out.push(rowOf(row, "", nested));
			if (nested.length > 0 && shutKids.includes(`${row.key}/${row.id}`)) out.push(kidsLine(row, nested));
			else nested.forEach((kid, k) => out.push(rowOf(kid, k < nested.length - 1 ? "child more" : "child")));
		}
		return out;
	};
	return (
		<aside className="side" data-kind="sidebar">
			<div className="side-in">
			<button className="newbtn" onClick={onNew} data-act="new">
				<Plus />
				{t.newTask}
			</button>
			<div className="hlist">
				{error !== null && deleting === null && linking === null ? <div className="side-err" data-kind="work-error">{error}</div> : null}
				{groupWorks(works).map((group) => (
					<section key={group.label} className={folds.includes(group.label) ? "shut" : ""}>
						<button className="grp gh" onClick={() => fold(group.label)} aria-expanded={!folds.includes(group.label)} data-act="fold-group">
							{group.label}
							<Chevron />
						</button>
						{folds.includes(group.label) ? null : rowsOf(group.works)}
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
			{linking !== null ? (
				<Dialog
					kind="link-pr"
					title={fmt(t.linkPrTitle, { title: linking.title === "" ? t.untitled : linking.title })}
					sub={linking.folder}
					busy={busy}
					error={error}
					confirm={t.linkPrConfirm}
					onCancel={() => setLinking(null)}
					onConfirm={() => {
						setBusy(true);
						void onLinkPr(linking, prDraft).then(
							() => (setBusy(false), setLinking(null), setError(null)),
							(e: Error) => (setBusy(false), setError(e.message)),
						);
					}}
				>
					<input className="dlg-in" autoFocus value={prDraft} placeholder={t.linkPrHint} aria-label={t.linkPrHint} data-field="link-pr-input" onChange={(e) => setPrDraft(e.target.value)} />
				</Dialog>
			) : null}
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
			{/* the foot of the sidebar: Settings, one row (the Functions fold that held only it is gone, owner 2026-11-04) */}
			<div className="fn">
				<button className={`fn-h${settingsOn ? " on" : ""}`} onClick={onSettings} data-act="settings">
					<Gear />
					{t.settings}
				</button>
			</div>
			</div>
		</aside>
	);
}
