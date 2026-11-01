import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskRow } from "../../shared/frames.js";
import { clock, t, tokens } from "../i18n/index.js";
import { groupDelta, groupLabel, segmentsOf } from "../state/groups.js";
import { folded, type Item, type Step as StepItem, type Turn } from "../state/model.js";
import { Blocks } from "./Answer.js";
import { Approval } from "./Approval.js";
import { Chevron } from "./Icons.js";
import { Delta, Step } from "./Step.js";
import { artifactsOf, PinnedContext, Thumbs } from "./Artifacts.js";
import { RunContext, WorkContext } from "./links.js";
import { Thinking } from "./Thinking.js";
import { useNow } from "./useNow.js";

interface Props {
	/** the run was cut off with the host: nothing is moving, so no spinner */
	readonly interrupted?: boolean;
	readonly turn: Turn;
	/** the items of the process: everything but the answer and the approvals still open */
	readonly items: readonly Item[];
	readonly tasks: readonly TaskRow[];
	readonly onAnswer: (decisionId: string, allow: boolean) => void;
}

/** What the person chose in a group (folded or not, image rows open, whether by hand, the image opened by itself), kept for this tab: a reload or a switch to another Work and back keeps it. */
interface Kept {
	readonly c?: boolean;
	readonly s: readonly string[];
	readonly h: boolean;
	readonly o: string | null;
}

function recall(key: string): Kept | null {
	try {
		return JSON.parse(sessionStorage.getItem(key) ?? "null") as Kept | null;
	} catch {
		return null;
	}
}

function keep(key: string, kept: Kept): void {
	try {
		sessionStorage.setItem(key, JSON.stringify(kept));
	} catch {
		// no storage: the choices last as long as the page
	}
}

function Group({ id, items, turn, tasks, onAnswer, interrupted, live }: Omit<Props, "items"> & { readonly id: string; readonly items: readonly Item[]; readonly interrupted: boolean; readonly live: boolean }): ReactNode {
	const store = `kiso-fold:${useContext(WorkContext)}:${useContext(RunContext)}:${id}`;
	const [saved] = useState(() => recall(store));
	// the person's choice (folded or not) wins over the fold at the run's end, both ways
	const [choice, setChoice] = useState<boolean | undefined>(saved?.c);
	const isFolded = folded(turn, choice) && !interrupted;
	const now = useNow(live);
	const steps = items.filter((i): i is StepItem => i.kind === "step");
	// image rows opened in place; live, the newest image opens by itself once, if the person follows the bottom and has opened nothing here by hand
	const [shown, setShown] = useState<ReadonlySet<string>>(new Set(saved?.s ?? []));
	const byHand = useRef(saved?.h ?? false);
	const opened = useRef<string | null>(saved?.o ?? null);
	const pinned = useContext(PinnedContext);
	const newest = [...steps].reverse().find((s) => artifactsOf(s).some((a) => a.kind === "image"))?.id;
	// the run, not this group, is what must be live: a picture may arrive after the next narration has begun
	const running = turn.phase === "running" && !interrupted;
	useEffect(() => {
		if (!running || newest === undefined || byHand.current || opened.current === newest || !pinned()) return;
		opened.current = newest;
		setShown((s) => new Set([...s, newest]));
	}, [running, newest]);
	useEffect(() => {
		if (choice !== undefined || shown.size > 0) keep(store, { ...(choice !== undefined ? { c: choice } : {}), s: [...shown], h: byHand.current, o: opened.current });
	}, [choice, shown, store]);
	const toggle = (id: string): void => {
		byHand.current = true;
		setShown((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
	};
	return (
		<div className={`grp${isFolded ? " folded" : ""}`} data-kind="group" data-folded={isFolded} {...(choice !== undefined ? { "data-hand": choice ? "closed" : "open" } : {})}>
			<button className="ph" onClick={() => setChoice(!isFolded)} aria-expanded={!isFolded}>
				<Chevron />
				{live ? <span className="dotpulse" /> : null}
				{/* the one live indicator of a run sits on its last group line: the label shimmers while it works */}
				<span className={`lab${live ? " shimmer" : ""}`} {...(live ? { "data-kind": "live" } : {})}>
					{steps.length === 0 ? t.working : groupLabel(steps, t.did, { more: t.didMore, moreOne: t.didMoreOne, failed: t.didFailed })}
				</span>
				<Delta d={groupDelta(steps)} />
				{live ? <span className="clk">{clock(now - (turn.startedAt ?? now))}</span> : null}
				{live && turn.live?.output != null ? <span className="clk">{`${tokens(turn.live.output)} out`}</span> : null}
				<Thumbs items={steps.flatMap(artifactsOf)} />
			</button>
			<div className="pw">
				<div className="pb">
					<div className="pb-in">
						{items.map((item) =>
							item.kind === "thinking" ? (
								<Thinking key={item.id} item={item} />
							) : item.kind === "step" ? (
								<Step key={item.id} step={item} task={tasks.find((r) => r.id === item.taskId)} frozen={interrupted} shown={shown.has(item.id)} onShow={() => toggle(item.id)} />
							) : item.kind === "ask" ? (
								<Approval key={item.id} ask={item} onAnswer={onAnswer} />
							) : null,
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * The process: narration and groups of steps taking turns. Every group is open while the run is live and folds to its own line
 * when the run ends, unless the person opened or closed it by hand; narration never folds. A group of thinking alone (thinking
 * before narration) has no line of its own, unless it is where the run is now.
 */
export function Process({ turn, items, tasks, onAnswer, interrupted = false }: Props): ReactNode {
	const live = turn.phase === "running" && !interrupted;
	const segments = segmentsOf(items);
	// while it works, the run's live line is its last group: one that is still empty when the run has nothing in a group yet
	if (live && segments.at(-1)?.kind !== "group") segments.push({ kind: "group", id: "live", items: [] });
	const lines = segments.filter((s) => s.kind === "group" && (s.items.some((i) => i.kind !== "thinking") || (live && s === segments.at(-1))));
		return (
		<div className={`proc${live ? "" : " ended"}`} data-kind="process" data-folded={lines.length > 0 && !live && !interrupted}>
			{segments.map((seg, i) => {
				const last = i === segments.length - 1;
				if (seg.kind === "say") return <Blocks key={seg.item.id} className="say" kind="say" text={seg.item.text} live={live && last} />;
				if (seg.kind === "line")
					return seg.item.kind === "steer" ? (
						<div key={seg.item.id} className="steer">
							{seg.item.text}
						</div>
					) : seg.item.kind === "notice" ? (
						<div key={seg.item.id} className="note" data-kind="notice">
							{seg.item.text}
						</div>
					) : null;
				if (!lines.includes(seg)) return seg.items.map((item) => (item.kind === "thinking" ? <Thinking key={item.id} item={item} /> : null));
				return <Group key={seg.id} id={seg.id} items={seg.items} turn={turn} tasks={tasks} onAnswer={onAnswer} interrupted={interrupted} live={live && last} />;
			})}
		</div>
	);
}
