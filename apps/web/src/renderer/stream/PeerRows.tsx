import { useContext, useState, type ReactNode } from "react";
import { t, fmt } from "../i18n/index.js";
import type { Step } from "../state/model.js";
import type { Peer } from "../state/peers.js";
import { CardsContext } from "./SessionCard.js";

/**
 * ADR-0062 § 11 (mocks 2 and 2b): messages between Works as default-collapsed rows. "Messaged @X <text…>" for a message this
 * Work sent; "Received message from X" for one it received, and "Received N messages" for several admitted together; "X
 * finished / failed / is waiting on you / ended with tasks running" for a child's completion. Opened, a row shows its text
 * only. A sender's name opens it.
 */

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
