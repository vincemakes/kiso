import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { EnvReply } from "../../shared/settings.js";
import { t } from "../i18n/index.js";
import type { Step } from "../state/model.js";
import { I } from "./Icons.js";

/**
 * ADR-0062 § 9: what a start_session call draws in its Work's stream, outside the folding group. `asked`: one line, "Started
 * <title> ›", opening the new Work. `named` and `proposed`: the Work card (New Work, the title, two lines of the brief, × to
 * dismiss, Do it here and Start) until the person answers; a proposed card left a week becomes "Suggestion expired: <title>".
 * A refused call (a turn another Work's message started) draws nothing: the model says so.
 */

type Cards = NonNullable<EnvReply["cards"]>;

export interface CardsHost {
	readonly cards: Cards;
	readonly titleOf: (sessionId: string) => string | undefined;
	/** ADR-0062: the title of the Work a message's `to` names by ref, or undefined (a title, or no single match) */
	readonly nameOf: (to: string) => string | undefined;
	/** open a Work: this folder's, or the folder `key` names */
	readonly open: (sessionId: string, key?: string) => void;
	readonly answer: (callId: string, action: "start" | "here" | "dismiss") => Promise<void>;
	/** read the cards again (a start_session call just finished) */
	readonly refresh: () => void;
	/** ADR-0062 § 8: messages held for the person, and their answer */
	readonly inbox: NonNullable<EnvReply["inbox"]>;
	readonly release: (messageId: string, action: "admit" | "drop") => Promise<void>;
}

export const CardsContext = createContext<CardsHost | null>(null);

const WEEK = 7 * 24 * 3600_000;

export function SessionCard({ step }: { readonly step: Step }): ReactNode {
	const host = useContext(CardsContext);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const card = host?.cards[step.callId];
	const done = step.status === "done";
	useEffect(() => {
		if (done && card === undefined) host?.refresh();
	}, [done, card === undefined]);
	if (host === null || !done || step.error !== null || card?.state === "dismissed" || card?.state === "here") return null;
	const input = step.input as { readonly title?: string; readonly brief?: string; readonly initiation?: string } | null;
	const title = card?.title ?? input?.title ?? "";
	if (card?.state === "started" || (card === undefined && input?.initiation === "asked")) {
		const work = card?.work;
		return (
			<button className="startrow" data-kind="started-work" disabled={work === undefined} onClick={() => work !== undefined && host.open(work)}>
				{t.startedWork} <b>{(work !== undefined ? host.titleOf(work) : undefined) ?? title}</b> <span className="chev">›</span>
			</button>
		);
	}
	if (card === undefined) return null;
	if (input?.initiation === "proposed" && Date.now() - card.at > WEEK)
		return (
			<div className="startrow expired" data-kind="suggestion-expired">
				{t.suggestionExpired} <span>{title}</span> <span className="chev">›</span>
			</div>
		);
	const act = (action: "start" | "here" | "dismiss"): void => {
		setBusy(true);
		setError(null);
		void host.answer(step.callId, action).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
	};
	return (
		<div className="wcard" data-kind="work-card">
			<div className="wcard-top">
				{t.newWork}
				<button className="ab" title={t.dismissCard} aria-label={t.dismissCard} disabled={busy} onClick={() => act("dismiss")} data-act="card-dismiss">
					<I.close />
				</button>
			</div>
			<div className="wcard-body">
				<b>{title}</b>
				<p>{input?.brief ?? ""}</p>
				{error === null ? null : <p className="wcard-err">{error}</p>}
				<div className="wcard-acts">
					<button className="wcard-here" disabled={busy} onClick={() => act("here")} data-act="card-here">{t.doItHere}</button>
					<button className="wcard-start" disabled={busy} onClick={() => act("start")} data-act="card-start">{t.startWork}</button>
				</div>
			</div>
		</div>
	);
}
