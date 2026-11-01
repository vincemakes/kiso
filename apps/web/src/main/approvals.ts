import type { Space } from "./space.js";

/**
 * Approvals that wait for a person, and runs that end, while the person is looking elsewhere.
 *
 * The page says where it is (`presence`: which Work, whether the tab has the focus), and every second this looks at the Works the host has
 * opened: an approval that waits and is not in front of the person is announced once, and so is a run that ended out of sight. Notices
 * are kept in a short numbered list the page reads (`/desk/notices`) and shows as a browser notification when the person turned them
 * on; a proof also gets a copy in a file. What is announced is the tool's name and the folder's name, never what the tool was asked to
 * do: a command can carry a secret.
 */

export interface Presence {
	readonly key: string;
	readonly session: string;
	readonly focused: boolean;
	/** when the page said so (ms); a page that stopped saying so is not present */
	readonly at: number;
}

export interface Notice {
	readonly seq: number;
	readonly kind: "approval" | "done";
	readonly key: string;
	readonly sessionId: string;
	/** approval only */
	readonly decisionId?: string;
	readonly tool?: string;
	readonly folder: string;
}

const FRESH_MS = 15_000;
const KEEP = 50;

export class ApprovalWatch {
	readonly #spaces: () => Iterable<Space>;
	readonly #notify: ((notice: Notice) => void) | undefined;
	readonly #presence: () => Presence | null;
	/** decisions already announced, per `key/session`; forgotten once answered */
	readonly #told = new Map<string, Set<string>>();
	/** Works seen running at the last look */
	readonly #running = new Set<string>();
	readonly #notices: Notice[] = [];
	#seq = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(spaces: () => Iterable<Space>, notify: ((notice: Notice) => void) | undefined, presence: () => Presence | null) {
		this.#spaces = spaces;
		this.#notify = notify;
		this.#presence = presence;
	}

	start(everyMs = 1_000): void {
		this.#timer = setInterval(() => void this.poll(), everyMs);
		this.#timer.unref();
	}

	stop(): void {
		clearInterval(this.#timer);
	}

	/** The notices after `seq` (the page keeps the last number it saw), and the newest number. */
	since(seq: number): { readonly seq: number; readonly notices: readonly Notice[] } {
		return { seq: this.#seq, notices: this.#notices.filter((n) => n.seq > seq) };
	}

	#announce(notice: Omit<Notice, "seq">): void {
		const full = { ...notice, seq: ++this.#seq };
		this.#notices.push(full);
		if (this.#notices.length > KEEP) this.#notices.shift();
		this.#notify?.(full);
	}

	async poll(): Promise<void> {
		const p = this.#presence();
		const here = p !== null && p.focused && Date.now() - p.at < FRESH_MS ? p : null;
		for (const space of this.#spaces()) {
			for (const sessionId of space.opened()) {
				const id = `${space.key}/${sessionId}`;
				const away = here === null || here.key !== space.key || here.session !== sessionId;
				const folder = space.workspace.split("/").pop() ?? "";
				const running = space.service.isRunning(sessionId);
				if (running) this.#running.add(id);
				else if (this.#running.delete(id) && away) this.#announce({ kind: "done", key: space.key, sessionId, folder });
				const pending = running ? await space.service.pendingApprovals(sessionId).catch(() => []) : [];
				const told = this.#told.get(id) ?? new Set<string>();
				const still = new Set<string>();
				for (const approval of pending) {
					if (told.has(approval.decisionId)) still.add(approval.decisionId);
					else if (away) {
						still.add(approval.decisionId);
						this.#announce({ kind: "approval", key: space.key, sessionId, decisionId: approval.decisionId, tool: approval.name, folder });
					}
				}
				if (still.size === 0) this.#told.delete(id);
				else this.#told.set(id, still);
			}
		}
	}
}
