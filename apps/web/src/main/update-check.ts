import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateReply } from "../shared/update.js";

/**
 * kiso web's check for a newer release of itself: one GET of the npm dist-tags document of `@vincemakes/kiso-web`, no identity, no
 * usage, no session data. It is the second thing kiso sends that is not to the model endpoint the person configured (the terminal's
 * own check is the first; this one shares no code with it). It never delays the first page, says nothing when it fails (no network,
 * a proxy, a 500, a malformed body, a slow answer: all silence), asks at most once a day, and is off with `KISO_NO_UPDATE_CHECK=1`
 * or with the Settings switch. A faux host (the tests and the demo) never asks, unless a test points `KISO_UPDATE_ENDPOINT` at a
 * local stub.
 */

const ENDPOINT = "https://registry.npmjs.org/-/package/@vincemakes/kiso-web/dist-tags";
const TIMEOUT_MS = 1_500;
const EVERY_MS = 24 * 60 * 60 * 1_000;

/** Whether `latest` is a newer release than `current`: three numeric parts; a prerelease of the same numbers is not newer; what cannot be read is never newer. */
export function isNewer(current: string, latest: string): boolean {
	const parse = (v: string): number[] | null => {
		const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
		return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
	};
	const a = parse(current);
	const b = parse(latest);
	if (a === null || b === null) return false;
	for (let i = 0; i < 3; i += 1) {
		if (b[i]! > a[i]!) return true;
		if (b[i]! < a[i]!) return false;
	}
	return false;
}

/** What the person chose, kept in `desktop.json` by the settings. */
export interface UpdateChoices {
	/** the Settings switch; absent means on */
	readonly enabled: () => boolean;
	/** the version whose pill the person closed */
	readonly hidden: () => string | undefined;
}

interface Cache {
	readonly checkedAt: number;
	readonly latest?: string;
}

export class UpdateWatch {
	readonly #file: string;
	readonly #version: string;
	readonly #choices: UpdateChoices;
	readonly #faux: boolean;
	#cache: Cache | null;
	#timer: ReturnType<typeof setInterval> | undefined;
	#asking: Promise<void> | undefined;

	constructor(o: { readonly home: string; readonly version: string; readonly choices: UpdateChoices; readonly faux: boolean }) {
		this.#file = join(o.home, "update-check-web.json");
		this.#version = o.version;
		this.#choices = o.choices;
		this.#faux = o.faux;
		this.#cache = this.#read();
	}

	#read(): Cache | null {
		try {
			const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, unknown> | null;
			if (raw === null || typeof raw !== "object" || typeof raw["checkedAt"] !== "number") return null;
			return { checkedAt: raw["checkedAt"], ...(typeof raw["latest"] === "string" ? { latest: raw["latest"] } : {}) };
		} catch {
			return null; // a missing or corrupt cache is no cache
		}
	}

	#envOff = (): boolean => process.env["KISO_NO_UPDATE_CHECK"] === "1";
	#endpoint = (): string => process.env["KISO_UPDATE_ENDPOINT"] ?? ENDPOINT;
	#mayAsk = (): boolean => !this.#envOff() && this.#choices.enabled() && !(this.#faux && process.env["KISO_UPDATE_ENDPOINT"] === undefined);

	state(): UpdateReply {
		const enabled = !this.#envOff() && this.#choices.enabled();
		const latest = enabled ? (this.#cache?.latest ?? null) : null;
		return {
			current: this.#version,
			latest,
			newer: latest !== null && isNewer(this.#version, latest),
			hidden: latest !== null && this.#choices.hidden() === latest,
			enabled,
			locked: this.#envOff(),
			checkedAt: this.#cache?.latest === undefined ? null : this.#cache.checkedAt,
		};
	}

	/** Ask the registry (when it may be asked, and not asked in the last day unless `force`); resolves to the state, never rejects. */
	async check(force = false): Promise<UpdateReply> {
		if (!this.#mayAsk() || (!force && this.#cache !== null && Date.now() - this.#cache.checkedAt < EVERY_MS)) return this.state();
		this.#asking ??= this.#ask().finally(() => (this.#asking = undefined));
		await this.#asking;
		return this.state();
	}

	async #ask(): Promise<void> {
		let latest: string | undefined;
		try {
			const ctl = new AbortController();
			const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
			try {
				const res = await fetch(this.#endpoint(), { signal: ctl.signal, headers: { accept: "application/json" } });
				if (res.ok) {
					const tag = ((await res.json()) as Record<string, unknown> | null)?.["latest"];
					if (typeof tag === "string" && tag !== "") latest = tag;
				}
			} finally {
				clearTimeout(timer);
			}
		} catch {
			// every failure is silence
		}
		// a failed ask keeps what it knew and waits a day, as the terminal's does
		const next: Cache = { checkedAt: Date.now(), ...((latest ?? this.#cache?.latest) === undefined ? {} : { latest: latest ?? this.#cache!.latest! }) };
		this.#cache = next;
		try {
			mkdirSync(dirname(this.#file), { recursive: true });
			writeFileSync(this.#file, `${JSON.stringify(next)}\n`, "utf8");
		} catch {
			// an unwritable home only means it asks again next start
		}
	}

	/** Ask now and again every day while the host runs; never holds the process open. */
	start(): void {
		void this.check();
		this.#timer = setInterval(() => void this.check(), EVERY_MS);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
	}
}
