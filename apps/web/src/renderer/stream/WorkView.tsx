import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { KeyContext, WorkContext } from "./links.js";
import { PinnedContext } from "./Artifacts.js";
import { Composer } from "./Composer.js";
import { useLink } from "./LinkLine.js";
import { Turn } from "./Turn.js";
import { isInterrupted, isLive } from "../state/model.js";
import { READING } from "../state/reading.js";
import type { Session } from "../state/store.js";
import { ResumeCard, VerdictPanel } from "./Interrupt.js";
import { t } from "../i18n/index.js";

// the input handed to the page at launch is sent once, into the first Work that opens
let autoSent = false;

interface Props {
	readonly session: Session;
	readonly auto: string | null;
	/** what an empty Work shows under its title: the tray under the input box, or the first-run guide in its place */
	readonly home?: { readonly tray: ReactNode; readonly guide: ReactNode | null };
	/** an approval a notification pointed at: scrolled to and focused once its card is there */
	readonly focusDecision?: string | null;
	readonly onFocused?: () => void;
	/** a line above the first run (a fork's notice of where it came from) */
	readonly lead?: ReactNode;
}

/** A Work on its way: nothing for the first 300 ms (a quick open never flashes it), then a few grey rows shaped like messages, with a light
 *  shimmer, until the first turn is drawn. */
export const Loading = (): ReactNode => (
	<div className="loading" data-kind="loading" role="status" aria-label={t.loading} aria-busy="true">
		<i className="me-sk" />
		<i />
		<i />
		<i />
	</div>
);

/** One Work: its stream and its input. A Work whose run died offers the resume card. */
/**
 * The line the person may send next after the Work's latest run, when it ended well (plan follow-up, owner 2026-11-03):
 * asked of the host, which asks the Work's own model at most once a run, and only for a run it carried itself (after a
 * restart it has nothing to repeat: none). Coming back to the Work shows the same line again at no cost; the next run
 * clears it.
 */
function useFollowUp(last: Session["state"]["turns"][number] | undefined): string | null {
	const work = useContext(WorkContext);
	const key = useContext(KeyContext);
	const asked = useRef(new Set<string>());
	const [line, setLine] = useState<{ readonly at: string; readonly text: string } | null>(null);
	const at = last === undefined ? "" : `${work}/${last.id}`;
	useEffect(() => {
		if (last === undefined || last.phase !== "ended" || last.outcome !== "completed" || last.endSeq === null || asked.current.has(at)) return;
		asked.current.add(at);
		const q = new URLSearchParams({ session: work, seq: String(last.endSeq), ...(key === null ? {} : { key }) });
		void fetch(`/desk/followup?${q}`)
			.then((r) => (r.ok ? (r.json() as Promise<{ line: string }>) : { line: "" }))
			.then((r) => r.line !== "" && setLine({ at, text: r.line }), () => undefined);
	}, [last, last?.phase, last?.outcome, at, work, key]);
	return line !== null && line.at === at && last?.phase === "ended" ? line.text : null;
}

export function WorkView({ session, auto, home, focusDecision, onFocused, lead }: Props): ReactNode {
	const version = useSyncExternalStore(session.subscribe, session.version);
	const down = useLink(session);
	const { turns, tasks } = session.state;
	const running = isLive(session.state);
	// shown again after a switch: until the host has been asked, an approval in it is not offered
	const suggestion = useFollowUp(turns.at(-1));
	const interrupted = isInterrupted(session.state);
	const uncertain = (session.state.snapshot?.uncertain.length ?? 0) > 0;
	const held = uncertain ? t.verdictFirst : null;
	const message = session.message();
	// Stick to the bottom while the person is there. Once they scroll up, the view is never moved for them: whatever the content does
	// (a step grows, the process folds at the end), the line they were reading stays where it was, and a "Latest" pill offers the way down.
	// (Done here, not by the browser's own scroll anchoring, which one of the two browsers does not have.)
	const scroller = useRef<HTMLDivElement>(null);
	const column = useRef<HTMLDivElement>(null);
	// room kept under the stream while the person reads above: content that shrinks below them (a fold) cannot pull the page up under them
	const spacer = useRef<HTMLDivElement>(null);
	const room = (px: number): void => void (spacer.current !== null && (spacer.current.style.height = `${Math.max(0, px)}px`));
	// how far the view's bottom is above the end of the content: the room is not content, so the person never scrolls into it
	const gap = (el: HTMLElement): number => el.scrollHeight - (spacer.current?.offsetHeight ?? 0) - el.scrollTop - el.clientHeight;
	// and room above, for a fold over them larger than the view can scroll back (the view cannot go above its top)
	const lift = useRef<HTMLDivElement>(null);
	const raise = (px: number): void => void (lift.current !== null && (lift.current.style.height = `${Math.max(0, px)}px`));
	const pinned = useRef(true);
	const anchor = useRef<{ readonly el: Element; readonly top: number } | null>(null);
	// where the view and the content were at the last look: the person's scroll is told from the page's own moves by its direction
	const last = useRef({ top: 0, height: 0 });
	const mark = (el: HTMLElement): void => void (last.current = { top: el.scrollTop, height: el.scrollHeight });
	const [behind, setBehind] = useState(false);
	// a fold can leave the view below the content's end (blank under the last line): going back to the end is then a glide, not a
	// jump, and the room goes only once the view is there (removing it first would snap the last line to the bottom)
	const glide = useRef(false);
	const settle = (el: HTMLElement): void => {
		glide.current = false;
		room(0);
		raise(0);
		mark(el);
	};
	const toBottom = (smooth = false): void => {
		pinned.current = true;
		session.view.pos = null;
		setBehind(false);
		room(0);
		raise(0);
		const el = scroller.current;
		if (el === null) return;
		el.scrollTo({ top: el.scrollHeight, ...(smooth ? { behavior: "smooth" } : {}) });
		if (!smooth) mark(el);
	};
	const remember = (): void => {
		const el = scroller.current;
		if (el === null) return;
		// the first block wholly in view that no fold can hide: the person's line, a process header, a block of the answer, a card, a footer
		const top = el.getBoundingClientRect().top;
		const at = Array.from(el.querySelectorAll(READING)).find((e) => e.getBoundingClientRect().top >= top);
		anchor.current = at === undefined ? null : { el: at, top: at.getBoundingClientRect().top };
		// kept with the Work, so a switch back finds them where they were: the block (its turn and its place among the turn's blocks) and its offset
		const turnEl = at?.closest("[data-turn]");
		session.view.pos = at === undefined || turnEl === null || turnEl === undefined ? null : { turn: turnEl.getAttribute("data-turn")!, n: Array.from(turnEl.querySelectorAll(READING)).indexOf(at), top: at.getBoundingClientRect().top - top };
	};
	// shown again where the person was reading, not at the end (before the first paint)
	useLayoutEffect(() => {
		const el = scroller.current;
		const saved = session.view.pos;
		const at = saved === null ? undefined : Array.from(column.current?.querySelector(`[data-turn="${CSS.escape(saved.turn)}"]`)?.querySelectorAll(READING) ?? [])[saved.n];
		if (el === null || at === undefined || saved === null) return;
		pinned.current = false;
		anchor.current = { el: at, top: el.getBoundingClientRect().top + saved.top };
		el.scrollTop += at.getBoundingClientRect().top - anchor.current.top;
		mark(el);
		setBehind(true);
	}, []);
	useEffect(() => {
		const el = scroller.current;
		const col = column.current;
		if (el === null || col === null) return;
		const follow = new ResizeObserver(() => {
			if (pinned.current) return void (glide.current || el.scrollTo({ top: el.scrollHeight }), mark(el));
			const a = anchor.current;
			if (a !== null && a.el.isConnected) {
				let want = el.scrollTop + a.el.getBoundingClientRect().top - a.top;
				if (want < 0) {
					raise((lift.current?.offsetHeight ?? 0) - want);
					want = 0;
				}
				const short = want - (el.scrollHeight - el.clientHeight);
				if (short > 0) room((spacer.current?.offsetHeight ?? 0) + short);
				el.scrollTop = want;
			}
			// the block the person chose stays the anchor through the page's own moves (a fold: re-choosing mid-fold could pick a
			// header whose body then folds under it); another is chosen only when they scroll, or when it is gone
			if (a === null || !a.el.isConnected) remember();
			mark(el);
			if (gap(el) > 40) setBehind(true);
		});
		follow.observe(col);
		// the stream itself gets shorter when the composer grows: at the end it stays at the end; a person reading above keeps their place
		const dock = new ResizeObserver(() => void (pinned.current && !glide.current && (el.scrollTo({ top: el.scrollHeight }), mark(el))));
		dock.observe(el);
		return () => (follow.disconnect(), dock.disconnect());
	}, []);
	useEffect(() => {
		if (focusDecision === null || focusDecision === undefined) return;
		let tries = 0;
		const timer = setInterval(() => {
			const card = document.querySelector(`[data-decision="${CSS.escape(focusDecision)}"]`);
			if (card !== null) {
				card.scrollIntoView({ block: "center" });
				(card.querySelector("[data-act=allow]") as HTMLElement | null)?.focus();
				clearInterval(timer);
				onFocused?.();
			} else if ((tries += 1) > 40) clearInterval(timer);
		}, 200);
		return () => clearInterval(timer);
	}, [focusDecision, onFocused]);
	useEffect(() => {
		if (auto !== null && !autoSent) {
			autoSent = true;
			void session.send(auto);
		}
	}, [session, auto]);
	const isPinned = useCallback(() => pinned.current, []);
	return (
		<PinnedContext.Provider value={isPinned}>
			<div
				className="scroll"
				ref={scroller}
				onScroll={(e) => {
					// The person moved up (and the content did not shrink, which is the browser pulling the view after a fold): stop following,
					// and, while a run can still fold, keep a screen of room below so a fold under them has somewhere to go. They moved down
					// to the end of the content (not of the room): follow again, and the room goes without moving the view.
					const el = e.currentTarget;
					if (glide.current) return void (gap(el) >= -1 ? settle(el) : mark(el));
					const up = el.scrollTop < last.current.top - 1 && el.scrollHeight >= last.current.height;
					const down = el.scrollTop > last.current.top + 1;
					if (up) {
						if (pinned.current && running) room(el.clientHeight);
						pinned.current = false;
						if (gap(el) > 40) setBehind(true);
					} else if (down && gap(el) < 40) {
						pinned.current = true;
						session.view.pos = null;
						setBehind(false);
						if (gap(el) < -1) {
							// a wheel during the glide cancels it: glide again from wherever it stopped, never drop the room under the view
							const go = (): void => void (glide.current && (gap(el) < -1 ? (el.scrollTo({ top: el.scrollTop + gap(el), behavior: "smooth" }), setTimeout(go, 400)) : settle(el)));
							glide.current = true;
							go();
						} else (room(0), raise(0));
					}
					// a move the page made itself (the anchor kept, above) is no move of the person's: same place as last marked
					if (!pinned.current && (up || down)) remember();
					mark(el);
				}}
			>
				<div ref={lift} aria-hidden="true" />
				<div className="col" ref={column}>
					{!session.loaded() && turns.length === 0 ? <Loading /> : null}
					{turns.length === 0 && home === undefined ? (
						<div className="empty">
							<b>kiso</b>
						</div>
					) : null}
					{turns.length > 0 ? lead : null}
					{turns.map((turn, i) => (
						<Turn key={turn.id} turn={turn} rev={i === turns.length - 1 ? version : 0} tasks={tasks} interrupted={interrupted && i === turns.length - 1} onAnswer={session.stale() ? null : (id, allow) => void session.approve(id, allow)} />
					))}
					<div ref={spacer} aria-hidden="true" />
					{uncertain ? <VerdictPanel state={session.state} onVerdict={(id, r) => void session.verdict(id, r)} /> : interrupted ? <ResumeCard onResume={() => void session.resume()} /> : null}
				</div>
			</div>
			{behind && turns.length > 0 ? (
				<button className="latest" data-act="latest" onClick={() => toBottom(true)}>
					{t.latest}
				</button>
			) : null}
			{message !== null ? (
				<div className="toast" data-kind="message">
					{message}
				</div>
			) : null}
			{turns.length === 0 && home !== undefined && session.loaded() ? (
				<div className="homebox" data-kind="home">
					<h1>{t.homeTitle}</h1>
					{home.guide ?? (
						<Composer inline down={down} held={held} view={session.view} running={running} onSend={(x) => session.send(x)} onSteer={(x) => session.steer(x)} onStop={() => void session.abort()}>
							{home.tray}
						</Composer>
					)}
				</div>
			) : (
				<Composer down={down} held={held} view={session.view} running={running} suggestion={suggestion} onSend={(x) => (toBottom(), session.send(x))} onSteer={(x) => session.steer(x)} onStop={() => void session.abort()} />
			)}
		</PinnedContext.Provider>
	);
}
