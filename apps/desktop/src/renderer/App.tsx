import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Composer } from "./stream/Composer.js";
import { Turn } from "./stream/Turn.js";
import { launchParams, openSession, type Session } from "./state/store.js";

// opened once, when the page loads: the address fragment can be read only once
const launch = launchParams();
const session: Session = openSession({ baseUrl: `${location.origin}/v1/sessions`, token: launch.token, sessionId: launch.sessionId });
(window as unknown as { __kiso: Session }).__kiso = session; // read by the proof scripts through the debugging port
const auto = launch.auto;
let autoSent = false;

/** The stream and its input: one session, no sidebar yet. */
export function App(): ReactNode {
	const version = useSyncExternalStore(session.subscribe, session.version);
	const { turns, tasks } = session.state;
	const last = turns.at(-1);
	const running = last?.phase === "running";
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
	}, []);
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
						<Turn key={turn.id} turn={turn} rev={i === turns.length - 1 ? version : 0} tasks={tasks} onAnswer={(id, allow) => void session.approve(id, allow)} />
					))}
				</div>
			</div>
			<Composer running={running} onSend={(x) => void session.send(x)} onSteer={(x) => void session.steer(x)} onStop={() => void session.abort()} />
		</>
	);
}
