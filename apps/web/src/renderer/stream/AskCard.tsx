import { useContext, useEffect, useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import type { Item, Step } from "../state/model.js";
import { answerAsk } from "../state/works.js";
import { KeyContext, WorkContext } from "./links.js";

/**
 * ADR-0062 § 10c (the owner's reference screenshots): an ask_user call waiting for the person, drawn in the stream, never over
 * the box. A grey head with the question and, for several, "‹ 1 of 2 ›"; one row per option (a radio, or a box for
 * multiSelect, the label, a grey line of description, "(Recommended)" after the recommended one); a last row "Other" that
 * takes typing; Skip, and Next ⌘↩ (Submit ⌘↩ on the last). Answered, the call is an ordinary step again. While it waits, a
 * line typed in the box is this question's Other (S2): `askInput`.
 */

type Q = { readonly question: string; readonly multiSelect?: boolean; readonly options: readonly { readonly label: string; readonly description?: string }[] };

/** Whether the Work's last run waits on an ask_user call (the sidebar and the stream show it as waiting for the person). */
export const isAsking = (turns: readonly { readonly items: readonly Item[] }[]): boolean =>
	(turns.at(-1)?.items ?? []).some((i) => i.kind === "step" && i.name === "ask_user" && (i.status === "running" || i.status === "calling" || i.status === "waiting"));

/** S2: the waiting card's door for a line typed in the box. */
export const askInput: { current: ((text: string) => void) | null } = { current: null };

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

export function AskCard({ step }: { readonly step: Step }): ReactNode {
	const key = useContext(KeyContext);
	const work = useContext(WorkContext);
	const qs = ((step.input?.["questions"] ?? []) as readonly Q[]).filter((q) => Array.isArray(q.options));
	const [page, setPage] = useState(0);
	const [picks, setPicks] = useState<number[][]>(() => qs.map(() => []));
	const [other, setOther] = useState<(string | null)[]>(() => qs.map(() => null));
	const [skipped, setSkipped] = useState<boolean[]>(() => qs.map(() => false));
	const [error, setError] = useState<string | null>(null);
	const submit = (o: (string | null)[], s: boolean[]): void => {
		const answers = qs.flatMap((q, i) => (s[i] ? [] : [o[i] !== null && o[i] !== "" ? { q: q.question, custom: o[i] } : q.multiSelect === true ? { q: q.question, choices: picks[i]!.map((n) => q.options[n]!.label) } : { q: q.question, choice: q.options[picks[i]![0] ?? 0]?.label ?? "" }]));
		const declined = qs.filter((_, i) => s[i]).map((q) => q.question);
		void answerAsk(key, work, step.callId, answers.length === 0 ? { declined } : declined.length === 0 ? { answers } : { answers, declined }).catch((e: Error) => setError(e.message));
	};
	const next = (o = other, s = skipped): void => (page < qs.length - 1 ? setPage(page + 1) : submit(o, s));
	useEffect(() => {
		askInput.current = (text) => next(other.map((x, i) => (i === page ? text : x)));
		const onKey = (e: KeyboardEvent): void => void (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), next()));
		addEventListener("keydown", onKey);
		return () => ((askInput.current = null), removeEventListener("keydown", onKey));
	});
	const q = qs[page];
	if (q === undefined) return null;
	const pick = (n: number): void => {
		setOther(other.map((x, i) => (i === page ? null : x)));
		setPicks(picks.map((p, i) => (i !== page ? p : q.multiSelect === true ? (p.includes(n) ? p.filter((m) => m !== n) : [...p, n]) : [n])));
	};
	const input = q.multiSelect === true ? "checkbox" : "radio";
	return (
		<div className="ask qcard" data-kind="question-card">
			<div className="q-head">
				<span>{q.question}</span>
				{qs.length > 1 ? (
					<span className="q-pager">
						<button disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t.qPrev}>‹</button> {fmt(t.qOf, { n: page + 1, of: qs.length })} <button disabled={page === qs.length - 1} onClick={() => setPage(page + 1)} aria-label={t.qNext}>›</button>
					</span>
				) : null}
			</div>
			{q.options.map((o, n) => (
				<label key={n} className="q-opt" data-act="q-option">
					<input type={input} name={`q${step.callId}-${page}`} checked={other[page] === null && picks[page]!.includes(n)} onChange={() => pick(n)} />
					<span><span><b>{o.label.replace(RECOMMENDED, "")}</b>{RECOMMENDED.test(o.label) ? <i> {t.qRecommended}</i> : null}</span>{o.description ? <small>{o.description}</small> : null}</span>
				</label>
			))}
			<label className="q-opt" data-act="q-other">
				<input type={input} name={`q${step.callId}-${page}`} checked={other[page] !== null} onChange={() => setOther(other.map((x, i) => (i === page ? (x ?? "") : x)))} />
				<span><b>{t.qOther}</b>{other[page] !== null ? <input className="q-text" autoFocus value={other[page] ?? ""} onChange={(e) => setOther(other.map((x, i) => (i === page ? e.target.value : x)))} /> : null}</span>
			</label>
			{error === null ? null : <p className="wcard-err">{error}</p>}
			<div className="wcard-acts">
				<button className="wcard-here" data-act="q-skip" onClick={() => ((s) => (setSkipped(s), next(other, s)))(skipped.map((x, i) => (i === page ? true : x)))}>{t.qSkip}</button>
				<button className="wcard-start" data-act="q-next" onClick={() => next()}>{page < qs.length - 1 ? t.qNextKey : t.qSubmitKey}</button>
			</div>
		</div>
	);
}
