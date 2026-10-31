import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DirsReply } from "../../shared/files.js";
import { t } from "../i18n/index.js";
import { fetchDirs } from "../state/desk.js";

interface Props {
	/** the chosen folder's full path; the host judges it again */
	readonly onChoose: (path: string) => void;
	readonly onClose: () => void;
}

/**
 * The folder browser: folders only, one level at a time, from the home folder or from a full path the person types (an external disk,
 * a folder outside home). The host lists the names and keeps the browsing inside the root it started from; this draws them.
 */
export function Folders({ onChoose, onClose }: Props): ReactNode {
	const dialog = useRef<HTMLDialogElement>(null);
	const [root, setRoot] = useState<string | null>(null);
	const [path, setPath] = useState("");
	const [reply, setReply] = useState<DirsReply | null>(null);
	const [typed, setTyped] = useState("");
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	useEffect(() => {
		let live = true;
		void fetchDirs(root, path).then(
			(r) => live && (setReply(r), setError(null)),
			(e: Error) => live && setError(e.message),
		);
		return () => {
			live = false;
		};
	}, [root, path]);
	const go = (nextRoot: string | null, nextPath: string): void => {
		setRoot(nextRoot);
		setPath(nextPath);
	};
	const parts = reply === null || reply.path === "" ? [] : reply.path.split("/");
	return (
		<dialog ref={dialog} className="folders" data-kind="folders" onClose={onClose}>
			<h2>{t.foldersTitle}</h2>
			<form
				className="frow"
				onSubmit={(e) => {
					e.preventDefault();
					if (typed.trim() !== "") go(typed.trim(), "");
				}}
			>
				<button type="button" className={`chip${root === null ? " on" : ""}`} onClick={() => go(null, "")} data-act="home">
					{t.foldersHome}
				</button>
				<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.foldersType} data-field="root" spellCheck={false} />
				<button type="submit" className="chip" data-act="root">
					{t.foldersAdd}
				</button>
			</form>
			<div className="crumbs" data-field="crumbs">
				<button onClick={() => go(root, "")}>{reply?.root.split("/").pop() || "/"}</button>
				{parts.map((name, i) => (
					<button key={i} onClick={() => go(root, parts.slice(0, i + 1).join("/"))}>
						{name}
					</button>
				))}
			</div>
			{error === null ? null : <div className="pnote warn">{error}</div>}
			<div className="dirs" data-kind="dirs">
				{reply !== null && reply.dirs.length === 0 ? <div className="muted">{t.foldersEmpty}</div> : null}
				{reply?.dirs.map((d) =>
					d.outside === true ? (
						<div key={d.name} className="dir off" data-dir={d.name} data-outside="1">
							{d.name} <small>{t.foldersOutside}</small>
						</div>
					) : (
						<button key={d.name} className="dir" data-dir={d.name} onClick={() => go(root, reply.path === "" ? d.name : `${reply.path}/${d.name}`)}>
							{d.name}
						</button>
					),
				)}
			</div>
			<div className="frow end">
				<span className="muted full" data-field="full" title={reply?.full}>
					{reply?.full ?? ""}
				</span>
				<button className="chip" onClick={() => dialog.current?.close()} data-act="cancel">
					{t.foldersCancel}
				</button>
				<button className="chip primary" disabled={reply === null || error !== null} onClick={() => reply !== null && (onChoose(reply.full), dialog.current?.close())} data-act="choose">
					{t.foldersOpen}
				</button>
			</div>
		</dialog>
	);
}
