import { fmt, t } from "../i18n/index.js";

/**
 * Browser notifications, off until the person turns them on with a click (a browser asks for permission only then). While the page is
 * open it reads the host's notices (an approval waits, a run ended, while the person looks elsewhere) and shows each one; a click
 * brings the tab forward and opens that Work. Two tabs show one notice once: the browser replaces a notification of the same tag.
 */

export interface Notice {
	readonly seq: number;
	readonly kind: "approval" | "done";
	readonly key: string;
	readonly sessionId: string;
	readonly decisionId?: string;
	readonly tool?: string;
	readonly folder: string;
}

export type NotifyState = "on" | "off" | "blocked" | "unsupported";

const KEY = "kiso.notify";
const POLL_MS = 2_000;

const remembered = (): boolean => {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
};
const remember = (on: boolean): void => {
	try {
		if (on) localStorage.setItem(KEY, "1");
		else localStorage.removeItem(KEY);
	} catch {
		// storage blocked: the choice lasts for this page only
	}
};
let onForPage = false;

export function notifyState(): NotifyState {
	if (typeof Notification === "undefined") return "unsupported";
	if (Notification.permission === "denied") return "blocked";
	return Notification.permission === "granted" && (onForPage || remembered()) ? "on" : "off";
}

/** Called from the person's click: asks the browser, then remembers the choice. */
export async function turnOn(): Promise<NotifyState> {
	if (typeof Notification === "undefined") return "unsupported";
	const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
	onForPage = permission === "granted";
	remember(onForPage);
	return notifyState();
}

export function turnOff(): NotifyState {
	onForPage = false;
	remember(false);
	return notifyState();
}

/** Read the notices while the page is open; `onOpen` is a click on one, `onSignedOut` a host that no longer knows this browser. */
export function watchNotices(onOpen: (n: Notice) => void, onSignedOut: () => void): () => void {
	let seq: number | null = null;
	const read = async (): Promise<void> => {
		const r = await fetch(`/desk/notices?after=${seq ?? 0}`).catch(() => null);
		if (r === null) return;
		if (r.status === 401) return onSignedOut();
		if (!r.ok) return;
		const body = (await r.json()) as { seq: number; notices: readonly Notice[] };
		// what was announced before this page opened is not news
		const fresh = seq === null ? [] : body.notices;
		seq = body.seq;
		if (notifyState() !== "on") return;
		for (const n of fresh) {
			const note = new Notification(n.kind === "approval" ? t.noticeWaiting : t.noticeDone, {
				body: n.kind === "approval" ? fmt(t.noticeWaitingBody, { tool: n.tool ?? "", folder: n.folder }) : fmt(t.noticeDoneBody, { folder: n.folder }),
				tag: `${n.key}/${n.sessionId}/${n.decisionId ?? `done-${n.seq}`}`,
			});
			note.onclick = () => {
				window.focus();
				onOpen(n);
				note.close();
			};
		}
	};
	void read();
	const timer = setInterval(() => void read(), POLL_MS);
	return () => clearInterval(timer);
}
