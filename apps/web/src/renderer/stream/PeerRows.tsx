import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { t, fmt } from "../i18n/index.js";
import type { Step } from "../state/model.js";
import type { Peer } from "../state/peers.js";
import { CardsContext } from "./SessionCard.js";

/** ADR-0062 § 11 (mocks 2, 2b): messages between Works as collapsed rows ("Messaged @X …", "Received message from X", "Received
 *  N messages", "X finished"); opened, a row shows its text only; a sender's name opens it. */

function Row({ head, body }: { readonly head: ReactNode; readonly body: string }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="prow" data-kind="peer-row">
			<button className="prow-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				{head} <span className="chev">{open ? "⌄" : "›"}</span>
			</button>
			{open && body !== "" ? <div className="prow-body">{body}</div> : null}
		</div>
	);
}

function Name({ peer }: { readonly peer: Peer }): ReactNode {
	const host = useContext(CardsContext);
	return (
		<span className="plink" role="link" data-act="peer-sender" onClick={(e) => (e.stopPropagation(), host?.open(peer.session, peer.key))}>
			{peer.title}
		</span>
	);
}

const STATES: Readonly<Record<string, string>> = { finished: t.peerFinished, failed: t.peerFailed, "waiting on you": t.peerWaiting, "ended with tasks still running": t.peerTasks };

export function PeerRow({ peer }: { readonly peer: Peer }): ReactNode {
	return peer.event === "completion" ? (
		<Row head={<><b><Name peer={peer} /></b> <span className="pstate">{STATES[peer.state] ?? peer.state}</span></>} body={peer.body} />
	) : (
		<Row head={<>{t.receivedFrom} <Name peer={peer} /></>} body={peer.body} />
	);
}

/** Several messages admitted at one boundary: one row, the messages inside. */
export function PeerGroup({ peers }: { readonly peers: readonly Peer[] }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="prow" data-kind="peer-group">
			<button className="prow-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				{fmt(t.receivedN, { n: peers.length })} <span className="chev">{open ? "⌄" : "›"}</span>
			</button>
			{open ? <div className="pgroup">{peers.map((p) => <PeerRow key={p.id} peer={p} />)}</div> : null}
		</div>
	);
}

/** A message this Work sent: to whom, and the opening of its text. */
export function MessagedRow({ step }: { readonly step: Step }): ReactNode {
	const input = step.input as { readonly to?: string; readonly text?: string } | null;
	if (step.status !== "done" || step.error !== null) return null;
	return (
		<Row
			head={
				<>
					{t.messaged} <span className="pto">@{input?.to ?? ""}</span> <span className="ptext">{input?.text ?? ""}</span>
				</>
			}
			body={input?.text ?? ""}
		/>
	);
}

/** ADR-0062 § 8 and S4 (mocks 2, 2c): the inbox at the stream's end, read again every few seconds: a message not read yet is
 *  "Message from X · read at the next step" (or "after your answer" while an approval waits); a held one has Drop and Admit. */
export function InboxRows({ seen, after }: { readonly seen: ReadonlySet<string>; readonly after: boolean }): ReactNode {
	const host = useContext(CardsContext);
	const [busy, setBusy] = useState(false);
	const latest = useRef(host);
	latest.current = host; // the page re-renders often: the timer reads the newest, and is set once
	useEffect(() => ((timer) => () => clearInterval(timer))(setInterval(() => latest.current?.refresh(), 4000)), []);
	const act = (id: string, action: "admit" | "drop"): void => (setBusy(true), void host?.release(id, action).finally(() => setBusy(false)));
	return (host?.inbox ?? []).filter((m) => !seen.has(m.id)).map((m) =>
		m.held ? (
			<div key={m.id} className="prow-line" data-kind="held-row">
				<Row head={<>{t.messageFrom} <span className="plink">{m.title}</span> · {t.heldTag}</>} body={m.text} />
				<button className="held-drop" disabled={busy} onClick={() => act(m.id, "drop")} data-act="held-drop">{t.dropHeld}</button>
				<button className="held-admit" disabled={busy} onClick={() => act(m.id, "admit")} data-act="held-admit">{t.admitHeld}</button>
			</div>
		) : (
			<div key={m.id} className="pwait" data-kind="waiting-row">
				<Row head={<>{t.messageFrom} {m.title} · {after ? t.readAfter : t.readNext}</>} body={m.text} />
			</div>
		),
	);
}
