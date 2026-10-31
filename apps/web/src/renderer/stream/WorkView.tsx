import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Composer } from "./Composer.js";
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
}

/** A Work on its way: quiet lines, shown after a moment so a quick open never flashes them. */
export const Loading = (): ReactNode => (
	<div className="loading" data-kind="loading" aria-busy="true">
		{t.loading}
		<i />
		<i />
		<i />
	</div>
);

/** One Work: its stream and its input. A Work whose run died offers the resume card. */
export function WorkView({ session, auto, home, focusDecision, onFocused }: Props): ReactNode {
	const version = useSyncExternalStore(session.subscribe, session.version);
	const { turns, tasks } = session.state;
	const running = isLive(session.state);
	const interrupted = isInterrupted(session.state);
	const uncertain = (session.state.snapshot?.uncertain.length ?? 0) > 0;
	const message = session.message();
	// Stick to the bottom while the person is there. Once they scroll up, the view is never moved for them: whatever the content does
	// (a step grows, the process folds at the end), the line they were reading stays where it was, and a "Latest" pill offers the way down.
	// (Done here, not by the browser's own scroll anchoring, which one of the two browsers does not have.)
	const scroller = useRef<HTMLDivElement>(null);
	const column = useRef<HTMLDivElement>(null);
	// room kept under the stream while the person reads above: content that shrinks below them (a fold) cannot pull the page up under them
	const spacer = useRef<HTMLDivElement>(null);
	const room = (px: number): void => void (spacer.current !== null && (spacer.current.style.height = `${Math.max(0, px)}px`));
	const pinned = useRef(true);
	const anchor = useRef<{ readonly el: Element; readonly top: number } | null>(null);
	// the content height the last scroll was judged at: a scroll that comes with another height is the browser clamping after a change, not the person
	const height = useRef(0);
	const [behind, setBehind] = useState(false);
	const toBottom = (smooth = false): void => {
		pinned.current = true;
		setBehind(false);
		room(0);
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight, ...(smooth ? { behavior: "smooth" } : {}) });
	};
	const remember = (): void => {
		const el = scroller.current;
		if (el === null) return;
		// the first block wholly in view that no fold can hide: the person's line, a process header, a block of the answer, a card, a footer
		const top = el.getBoundingClientRect().top;
		const at = Array.from(el.querySelectorAll(READING)).find((e) => e.getBoundingClientRect().top >= top);
		anchor.current = at === undefined ? null : { el: at, top: at.getBoundingClientRect().top };
	};
	useEffect(() => {
		const el = scroller.current;
		const col = column.current;
		if (el === null || col === null) return;
		const follow = new ResizeObserver(() => {
			height.current = el.scrollHeight;
			if (pinned.current) return void el.scrollTo({ top: el.scrollHeight });
			const a = anchor.current;
			if (a !== null && a.el.isConnected) {
				const want = el.scrollTop + a.el.getBoundingClientRect().top - a.top;
				const short = want - (el.scrollHeight - el.clientHeight);
				if (short > 0) room((spacer.current?.offsetHeight ?? 0) + short);
				el.scrollTop = want;
			}
			remember();
			height.current = el.scrollHeight;
			if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) setBehind(true);
		});
		follow.observe(col);
		return () => follow.disconnect();
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
	return (
		<>
			<div
				className="scroll"
				ref={scroller}
				onScroll={(e) => {
					// the person scrolled up: stop following until they come back to the bottom
					const el = e.currentTarget;
					if (el.scrollHeight !== height.current && height.current !== 0) return;
					const was = pinned.current;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
					if (pinned.current) (setBehind(false), room(0));
					else {
						// a screen of room the moment they leave the bottom: a fold below them has somewhere to go without pulling the page
						if (was) room(el.clientHeight);
						remember();
						height.current = el.scrollHeight;
					}
				}}
			>
				<div className="col" ref={column}>
					{!session.loaded() && turns.length === 0 ? <Loading /> : null}
					{turns.length === 0 && home === undefined ? (
						<div className="empty">
							<b>kiso</b>
						</div>
					) : null}
					{turns.map((turn, i) => (
						<Turn key={turn.id} turn={turn} rev={i === turns.length - 1 ? version : 0} tasks={tasks} interrupted={interrupted && i === turns.length - 1} onAnswer={(id, allow) => void session.approve(id, allow)} />
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
						<Composer inline running={running} onSend={(x) => void session.send(x)} onSteer={(x) => void session.steer(x)} onStop={() => void session.abort()}>
							{home.tray}
						</Composer>
					)}
				</div>
			) : (
				<Composer running={running} onSend={(x) => (toBottom(), void session.send(x))} onSteer={(x) => void session.steer(x)} onStop={() => void session.abort()} />
			)}
		</>
	);
}
