import { useEffect, useState, type ReactNode } from "react";
import type { GitFile } from "../../shared/git.js";
import { fmt, t } from "../i18n/index.js";

/** A dialog over the window: Esc or Cancel closes it; nothing it holds is done until its confirm. `kind` names it for the proofs. */
export function Dialog({ kind = "git", danger = false, title, sub, busy, error, confirm, onConfirm, onCancel, children }: { readonly kind?: string; readonly danger?: boolean; readonly title: string; readonly sub: string; readonly busy: boolean; readonly error: string | null; readonly confirm: string; readonly onConfirm: () => void; readonly onCancel: () => void; readonly children: ReactNode }): ReactNode {
	useEffect(() => {
		const key = (e: KeyboardEvent): void => void (e.key === "Escape" && !busy && onCancel());
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, [busy, onCancel]);
	return (
		<div className="dlg-veil" data-kind={`${kind}-dialog`} role="dialog" aria-label={title}>
			<div className="dlg">
				<h3>{title}</h3>
				<div className="dlg-sub mono">{sub}</div>
				{children}
				{error !== null ? <div className="dlg-err" data-kind={`${kind}-error`}>{error}</div> : null}
				<div className="dlg-btns">
					<button type="button" onClick={onCancel} disabled={busy} data-act={`${kind}-cancel`}>
						{t.cancel}
					</button>
					<button type="button" className={danger ? "go danger" : "go"} onClick={onConfirm} disabled={busy} data-act={`${kind}-confirm`}>
						{busy ? t.working : confirm}
					</button>
				</div>
			</div>
		</div>
	);
}

const failed = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Commit: the changed files, each ticked (untick to leave one out), and the message; only the ticked paths are committed. */
export function CommitDialog({ branch, files, draft, onCommit, onCancel }: { readonly branch: string; readonly files: readonly GitFile[]; readonly draft: string; readonly onCommit: (message: string, paths: readonly string[]) => Promise<void>; readonly onCancel: () => void }): ReactNode {
	const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(files.map((f) => f.path)));
	const [message, setMessage] = useState(draft);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const go = (): void => {
		setBusy(true);
		setError(null);
		void onCommit(message, [...picked]).catch((e: unknown) => (setError(failed(e)), setBusy(false)));
	};
	return (
		<Dialog title={t.commitTitle} sub={fmt(t.commitSub, { branch, n: picked.size })} busy={busy} error={error} confirm={t.commitGo} onConfirm={go} onCancel={onCancel}>
			<div className="dlg-files">
				{files.map((f) => (
					<label key={f.path} className="dlg-file">
						<input type="checkbox" checked={picked.has(f.path)} onChange={(e) => setPicked((p) => (e.target.checked ? new Set([...p, f.path]) : new Set([...p].filter((x) => x !== f.path))))} data-commit-file={f.path} />
						<span className="mono">{f.path}</span>
						<small>{f.state === "modified" ? "" : t.gitState[f.state]}</small>
					</label>
				))}
			</div>
			<label className="dlg-l">{t.commitMessage}</label>
			<textarea className="dlg-in" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} data-field="commit-message" />
		</Dialog>
	);
}

/** A pull request: its title and description, drafted from the branch's commits and editable; confirm pushes the branch and opens it. */
export function PrDialog({ branch, base, ahead, draft, onCreate, onCancel }: { readonly branch: string; readonly base: string; readonly ahead: number; readonly draft: () => Promise<{ readonly title: string; readonly body: string }>; readonly onCreate: (title: string, body: string) => Promise<void>; readonly onCancel: () => void }): ReactNode {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => void draft().then((d) => (setTitle(d.title), setBody(d.body)), () => undefined), [draft]);
	const go = (): void => {
		setBusy(true);
		setError(null);
		void onCreate(title, body).catch((e: unknown) => (setError(failed(e)), setBusy(false)));
	};
	return (
		<Dialog title={t.prTitle} sub={fmt(t.prSub, { branch, base, n: ahead })} busy={busy} error={error} confirm={t.prGo} onConfirm={go} onCancel={onCancel}>
			<label className="dlg-l">{t.prTitleLabel}</label>
			<input className="dlg-in" value={title} onChange={(e) => setTitle(e.target.value)} data-field="pr-title" />
			<label className="dlg-l">{t.prBodyLabel}</label>
			<textarea className="dlg-in" rows={6} value={body} onChange={(e) => setBody(e.target.value)} data-field="pr-body" />
		</Dialog>
	);
}
