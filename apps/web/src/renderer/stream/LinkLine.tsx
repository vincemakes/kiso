import { useEffect, useState, useSyncExternalStore } from "react";
import { fmt, t } from "../i18n/index.js";
import type { Session } from "../state/store.js";

/** What the person is told about a lost connection, and what Send says while it lasts. */
export interface Down {
	readonly text: string;
	readonly retry: (() => void) | null;
}

const offlineNow = (f: () => void): (() => void) => (addEventListener("online", f), addEventListener("offline", f), () => (removeEventListener("online", f), removeEventListener("offline", f)));

/** Nothing for a blip (under 2 s); "Reconnecting…" after; after 30 s the time of the next try and a button; "offline" at once. */
export function useLink(session: Session): Down | null {
	const [, tick] = useState(0);
	const link = useSyncExternalStore(session.subscribe, session.link);
	const offline = useSyncExternalStore(offlineNow, () => !navigator.onLine);
	useEffect(() => {
		if (link.state.kind === "open") return;
		const id = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, [link]);
	if (link.state.kind === "open") return null;
	if (offline) return { text: t.offline, retry: null };
	const now = Date.now();
	if (now - link.since < 2_000) return null;
	if (link.state.kind === "refused") return { text: t.cantReachNow, retry: null };
	if (now - link.since < 30_000 || link.state.kind !== "retrying") return { text: t.reconnecting, retry: null };
	return { text: fmt(t.cantReach, { s: Math.max(0, Math.ceil((link.state.nextAt - now) / 1000)) }), retry: session.retryNow };
}

export const LinkLine = ({ down }: { readonly down: Down }) => (
	<div className="link" data-kind="link" role="status">
		<span className="sp" />
		{down.text}
		{down.retry !== null ? <> · <button onClick={down.retry} data-act="retry-now">{t.retryNow}</button></> : null}
	</div>
);
