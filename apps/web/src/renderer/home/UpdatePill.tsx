import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import { fetchUpdate, hideUpdate } from "../state/update.js";
import { I } from "../stream/Icons.js";
import type { UpdateReply } from "../../shared/update.js";

export const UPDATE_COMMAND = "npm install -g @vincemakes/kiso-web@latest";
export const RELEASES = "https://github.com/vincemakes/kiso/releases";

/**
 * A newer kiso web is known: one small chip above the box on the new-conversation screen (a reference product's pattern), "Update
 * available" with a close mark. It is never in a running conversation, never in the stream, never a modal or a toast. A click opens
 * what to do (copy the command, restart, what's new); it never runs npm. The close mark hides it for that release only.
 */
export function UpdatePill(): ReactNode {
	const [u, setU] = useState<UpdateReply | null>(null);
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	// the host asks the registry at start, at the same moment the page opens: while nothing is known yet, look again twice
	useEffect(() => {
		let gone = false;
		const look = (left: number): void =>
			void fetchUpdate().then(
				(r) => {
					if (gone) return;
					setU(r);
					if (r.enabled && r.latest === null && left > 0) setTimeout(() => look(left - 1), 3000);
				},
				() => undefined,
			);
		look(2);
		return () => void (gone = true);
	}, []);
	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) !== true && setOpen(false));
		const esc = (e: KeyboardEvent): void => void (e.key === "Escape" && setOpen(false));
		addEventListener("mousedown", away);
		addEventListener("keydown", esc);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", esc));
	}, [open]);
	if (u === null || !u.enabled || !u.newer || u.hidden || u.latest === null) return null;
	const copy = (): void => {
		const done = (): void => (setCopied(true), void setTimeout(() => setCopied(false), 1500));
		void navigator.clipboard.writeText(UPDATE_COMMAND).then(done, () => undefined);
	};
	return (
		<div className="uppill" data-kind="update-pill" ref={box}>
			<div className="upchip">
				<button type="button" className="upmain" data-act="update-open" aria-expanded={open} onClick={() => setOpen(!open)}>
					<I.down />
					{t.updateAvailable}
				</button>
				<button type="button" className="upx" data-act="update-hide" aria-label={t.updateHide} title={t.updateHide} onClick={() => void hideUpdate(u.latest!).then(setU, () => undefined)}>
					×
				</button>
			</div>
			{open ? (
				<div className="uppop" data-kind="update-popover" role="dialog">
					<p>{fmt(t.updateIs, { latest: u.latest, current: u.current })}</p>
					<div className="upcmd">
						<code>{UPDATE_COMMAND}</code>
						<button type="button" className="chip" data-act="update-copy" onClick={copy}>
							{copied ? t.updateCopied : t.updateCopy}
						</button>
					</div>
					<small>{t.updateThen}</small>
					<a href={RELEASES} target="_blank" rel="noopener noreferrer" data-act="update-news">
						{t.updateWhatsNew}
					</a>
				</div>
			) : null}
		</div>
	);
}
