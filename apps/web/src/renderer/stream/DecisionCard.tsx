import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DecisionCard as Card } from "../../shared/decision.js";
import { t } from "../i18n/index.js";
import { fetchDecision, postDecision } from "../state/desk.js";
import { I } from "./Icons.js";

/**
 * The decision card (plan-decision-card-2026-11-24): what finish_with_choices left in front of the person, under the turn's last
 * message. Whether it is live is the host's to say (a pure function of the log, read again whenever the Work's turns move); the
 * page sends `{ callId, option }` and nothing else. The first choice is drawn dark with ⌘↩ unless `recommended` is false (both
 * equal, no shortcut). × hides it in this page only.
 */
export function useDecision(key: string | null, session: string, moved: string): readonly [Card | null, () => void] {
	const [card, setCard] = useState<Card | null>(null);
	const [again, setAgain] = useState(0);
	useEffect(() => {
		let live = true;
		void fetchDecision(key, session).then((r) => live && setCard(r.card), () => live && setCard(null));
		return () => void (live = false);
	}, [key, session, moved, again]);
	return [card, () => setAgain((n) => n + 1)];
}

/** What the Work's stream hands its last turn: the live card (if any), whose turn it hangs under, and how to ask again after a 409. */
export const DecisionContext = createContext<{ readonly card: Card | null; readonly turnId: string | undefined; readonly workKey: string | null; readonly session: string; readonly gone: () => void } | null>(null);

/** The card, drawn inside the turn it ends: under that turn's final message, above its footer. */
export function DecisionSlot({ turnId }: { readonly turnId: string }): ReactNode {
	const d = useContext(DecisionContext);
	return d?.card != null && d.turnId === turnId ? <DecisionCard card={d.card} workKey={d.workKey} session={d.session} gone={d.gone} /> : null;
}

function DecisionCard({ card, workKey, session, gone }: { readonly card: Card; readonly workKey: string | null; readonly session: string; readonly gone: () => void }): ReactNode {
	const [hidden, setHidden] = useState(false);
	const [busy, setBusy] = useState(false);
	const pick = (option: number): void => {
		setBusy(true);
		void postDecision(workKey, session, card.callId, option).catch(gone).finally(() => setBusy(false));
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			const box = document.activeElement;
			const empty = !(box instanceof HTMLTextAreaElement) || box.value === "";
			if (card.recommended && !busy && empty && e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), pick(0));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [card.callId, card.recommended, busy]);
	if (hidden) return null;
	return (
		<div className="dcard" data-kind="decision-card" data-recommended={String(card.recommended)}>
			{card.choices.map((label, n) => (
				<button key={n} className={card.recommended && n === 0 ? "dc-pri" : "dc-opt"} disabled={busy} onClick={() => pick(n)} data-act="choice" data-option={n}>
					{label}
					{card.recommended && n === 0 ? <kbd>⌘↩</kbd> : null}
				</button>
			))}
			<button className="ab" title={t.dismissCard} aria-label={t.dismissCard} onClick={() => setHidden(true)} data-act="choice-dismiss">
				<I.close />
			</button>
		</div>
	);
}
