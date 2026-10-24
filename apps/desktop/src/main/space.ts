import { SessionStore } from "@vincemakes/kiso-runtime";
import { createSessionService, toWireEvent, type SessionService } from "@vincemakes/kiso-server";
import { createHttpHandler, type HttpHandlerOptions } from "@vincemakes/kiso-server/http";
import type { Event } from "@vincemakes/kiso-core";
import type { WireFrame } from "@vincemakes/kiso-protocol";
import { createDesktopAgent, routeOf, type ModelChoice } from "./agent.js";
import { createTaskHub, rowsOf, type TaskHub } from "./tasks.js";
import { runTotals, usageFrameAt } from "./usage.js";
import { desktopSanitize } from "./sanitize.js";
import { TimeIndex } from "./times.js";
import type { AtFrame, TasksFrame, ToolOutputFrame } from "../shared/frames.js";

/**
 * One project folder's sessions as a service: the store in the folder's
 * session directory, the hosted-session service over it, the task hub, the
 * desktop's frames beside the wire events, and the HTTP handler under its
 * own route prefix. The host holds one space per folder in use; a Work is
 * served by the space of the folder it was started in.
 */

export interface SpaceOptions {
	readonly key: string;
	/** The folder the tools work in (the realpath). */
	readonly workspace: string;
	/** The session directory of that folder (`projects/<enc>/`). */
	readonly dir: string;
	readonly prefix: string;
	/** Read when a Work is opened, so a change in Settings reaches the Works opened after it; throws, in words, when no model can run. */
	readonly model: () => ModelChoice;
	readonly checkRunners: () => readonly string[];
	readonly secretEnvNames?: readonly string[];
	readonly exposeThinking: boolean;
	readonly sanitizer: "default" | "desktop";
	readonly keepaliveMs?: number;
	readonly toolLimits?: { readonly minForegroundMs?: number; readonly maxForegroundMs?: number };
}

export interface Space {
	readonly key: string;
	readonly workspace: string;
	readonly dir: string;
	readonly store: SessionStore;
	readonly service: SessionService;
	readonly tasks: TaskHub;
	readonly handler: ReturnType<typeof createHttpHandler>;
	/** Orderly exit, in the order that keeps every run resumable (packages/server README): `drain` first, then the host stops listening, then `close`. */
	readonly drain: (graceMs: number) => Promise<unknown>;
	readonly close: () => Promise<void>;
}

const HEAD_LINES = 12;
const DELTAS = new Set<Event["type"]>(["thinking", "text_delta"]);

export function createSpace(options: SpaceOptions): Space {
	const store = new SessionStore(options.dir);
	const tasks = createTaskHub(options.dir);
	const route = (): string => {
		try {
			return routeOf(options.model());
		} catch {
			return "unknown";
		}
	};

	const service = createSessionService({
		store,
		open: async (sessionId) =>
			createDesktopAgent({
				store,
				workspace: options.workspace,
				model: options.model(),
				sessionId,
				checkRunners: options.checkRunners(),
				tasks,
				...(options.secretEnvNames !== undefined ? { secretEnvNames: options.secretEnvNames } : {}),
				...(options.toolLimits !== undefined ? { toolLimits: options.toolLimits } : {}),
				onSession: (sessionId, session) => {
					// the model hears how a task ended; nothing wakes an idle session
					session.useTasks(tasks.managerFor(sessionId), { wake: false });
				},
			}),
	});

	const windowOf = (): number | null => {
		try {
			const m = options.model();
			return m.kind === "profile" ? (m.contextWindow ?? null) : null;
		} catch {
			return null;
		}
	};
	const times = new TimeIndex(store);
	const augment: NonNullable<HttpHandlerOptions["augment"]> = (event: Event, sessionId: string): readonly WireFrame[] => {
		const frames: WireFrame[] = [];
		// when it happened: for every wire event but the two delta types, which are too many
		if (!DELTAS.has(event.type) && toWireEvent(event) !== null) {
			const at: AtFrame = { seq: event.seq, ts: times.at(sessionId, event.seq) };
			frames.push({ event: "at", data: at });
		}
		frames.push(...derived(event, sessionId));
		return frames;
	};
	const derived = (event: Event, sessionId: string): readonly WireFrame[] => {
		if (event.type === "usage") {
			const frame = usageFrameAt(service.events(sessionId), event.seq, route());
			return frame === null ? [] : [{ event: "usage", data: { ...frame, window: windowOf() } }];
		}
		if (event.type === "terminal") {
			const totals = runTotals(service.events(sessionId), event.seq, route());
			return totals === null ? [] : [{ event: "run_usage", data: { seq: event.seq, ...totals } }];
		}
		if (event.type === "tool_result") {
			const text = typeof event.content === "string" ? event.content : event.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
			const lines = text.split("\n");
			const frame: ToolOutputFrame = {
				seq: event.seq,
				callId: event.callId,
				isError: event.isError,
				head: lines.slice(0, HEAD_LINES),
				lines: lines.length,
				bytes: Buffer.byteLength(text),
				truncated: lines.length > HEAD_LINES,
			};
			return [{ event: "tool_output", data: frame }];
		}
		return [];
	};

	// The tasks frame: not tied to any event (a command can end while nothing
	// else happens), so it is the host's own source, polled while a stream is open.
	const frames: NonNullable<HttpHandlerOptions["frames"]> = (sessionId, push) => {
		let last = "";
		const tick = (): void => {
			try {
				const rows = rowsOf(tasks.managerFor(sessionId));
				// elapsed time of a running task changes every tick; the state does not
				const key = JSON.stringify(rows.map((r) => [r.id, r.label]));
				const running = rows.some((r) => r.endedAt === null);
				if (key !== last || running) {
					last = key;
					const frame: TasksFrame = { at: Date.now(), tasks: rows };
					push({ event: "tasks", data: frame });
				}
			} catch {
				// a corrupt journal is the terminal's to report; the stream goes on
			}
		};
		tick();
		const timer = setInterval(tick, 1_000);
		timer.unref();
		return () => clearInterval(timer);
	};

	const handler = createHttpHandler(service, {
		prefix: options.prefix,
		// the host's guard has already run: bearer token, Host and Origin
		authorize: () => true,
		augment,
		frames,
		projection: { exposeThinking: options.exposeThinking, ...(options.sanitizer === "default" ? {} : { sanitize: desktopSanitize }) },
		...(options.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
	});

	return {
		key: options.key,
		workspace: options.workspace,
		dir: options.dir,
		store,
		service,
		tasks,
		handler,
		drain: (graceMs) => service.drain(graceMs),
		close: async () => {
			await tasks.close();
			store.closeAll();
		},
	};
}
