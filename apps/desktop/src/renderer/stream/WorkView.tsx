import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Composer } from "./Composer.js";
import { Turn } from "./Turn.js";
import { isInterrupted, isLive } from "../state/model.js";
import type { Session } from "../state/store.js";
import { ResumeCard, VerdictPanel } from "./Interrupt.js";

// the input handed to the page at launch is sent once, into the first Work that opens
let autoSent = false;

/** One Work: its stream and its input. A Work whose run died offers the resume card. */
export function WorkView({ session, auto }: { readonly session: Session; readonly auto: string | null }): ReactNode {
	const version = useSyncExternalStore(session.subscribe, session.version);
	const { turns, tasks } = session.state;
	const running = isLive(session.state);
	const interrupted = isInterrupted(session.state);
	const uncertain = (session.state.snapshot?.uncertain.length ?? 0) > 0;
	const message = session.message();
	// stick to the bottom while the person is at the bottom
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	useEffect(() => {
		const el = scroller.current;
		if (el !== null && pinned.current) el.scrollTo({ top: el.scrollHeight });
	}, [version]);
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
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				<div className="col">
					{turns.length === 0 ? (
						<div className="empty">
							<b>kiso</b>
						</div>
					) : null}
					{turns.map((turn, i) => (
						<Turn key={turn.id} turn={turn} rev={i === turns.length - 1 ? version : 0} tasks={tasks} interrupted={interrupted && i === turns.length - 1} onAnswer={(id, allow) => void session.approve(id, allow)} />
					))}
					{uncertain ? <VerdictPanel state={session.state} onVerdict={(id, r) => void session.verdict(id, r)} /> : interrupted ? <ResumeCard onResume={() => void session.resume()} /> : null}
				</div>
			</div>
			{message !== null ? (
				<div className="toast" data-kind="message">
					{message}
				</div>
			) : null}
			<Composer running={running} onSend={(x) => void session.send(x)} onSteer={(x) => void session.steer(x)} onStop={() => void session.abort()} />
		</>
	);
}
