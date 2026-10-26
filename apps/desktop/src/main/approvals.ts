import type { Space } from "./space.js";

/**
 * Approvals that wait for a person while the person is looking elsewhere.
 *
 * The page says where it is (`presence`: which Work, whether the window has the focus), and every second this looks at the Works the host has
 * opened that are running: an approval that waits and is not in front of the person is announced once, through a channel the host is
 * given (a system notification in the app, a file in a proof). What is announced is the tool's name and the folder's name, never what the
 * tool was asked to do: a command can carry a secret.
 */

export interface Presence {
	readonly key: string;
	readonly session: string;
	readonly focused: boolean;
	/** when the page said so (ms); a page that stopped saying so is not present */
	readonly at: number;
}

export interface ApprovalNotice {
	readonly key: string;
	readonly sessionId: string;
	readonly decisionId: string;
	readonly tool: string;
	readonly folder: string;
}

const FRESH_MS = 15_000;

export class ApprovalWatch {
	readonly #spaces: () => Iterable<Space>;
	readonly #notify: (notice: ApprovalNotice) => void;
	readonly #presence: () => Presence | null;
	/** decisions already announced, per `key/session`; forgotten once answered */
	readonly #told = new Map<string, Set<string>>();
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(spaces: () => Iterable<Space>, notify: (notice: ApprovalNotice) => void, presence: () => Presence | null) {
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

	async poll(): Promise<void> {
		const p = this.#presence();
		const here = p !== null && p.focused && Date.now() - p.at < FRESH_MS ? p : null;
		for (const space of this.#spaces()) {
			for (const sessionId of space.opened()) {
				const id = `${space.key}/${sessionId}`;
				const pending = space.service.isRunning(sessionId) ? await space.service.pendingApprovals(sessionId).catch(() => []) : [];
				const told = this.#told.get(id) ?? new Set<string>();
				const still = new Set<string>();
				for (const approval of pending) {
					if (told.has(approval.decisionId)) still.add(approval.decisionId);
					else if (here === null || here.key !== space.key || here.session !== sessionId) {
						still.add(approval.decisionId);
						this.#notify({ key: space.key, sessionId, decisionId: approval.decisionId, tool: approval.name, folder: space.workspace.split("/").pop() ?? "" });
					}
				}
				if (still.size === 0) this.#told.delete(id);
				else this.#told.set(id, still);
			}
		}
	}
}
