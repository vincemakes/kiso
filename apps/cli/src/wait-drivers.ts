/**
 * ADR-0059 release 1 — the CLI's wait drivers for GitHub, over `gh`.
 *
 * Two sources a wait can name:
 *
 *   { kind: "gh-checks", pr, repo? }  fires when every check on the PR's
 *                                      current head has a conclusion
 *   { kind: "gh-review", pr, repo? }  fires when a review or a comment
 *                                      that did not exist at registration
 *                                      appears
 *
 * Polling, not webhooks (release 2c): one `gh` call per interval, no
 * tokens. The payload carries what `gh` reported — the head sha as the
 * VERSION the evidence is about (a fired checks wait for sha A says
 * nothing about sha B), and the checks or reviews themselves — never a
 * summary of them. The event identity dedupes a second observation of
 * the same state (W5).
 *
 * These are registered host-side (`TaskManager({ drivers })`), so the
 * runtime learns no GitHub; a second host registers its own.
 */
import { execFile } from "node:child_process";
import type { WaitDriver, WaitInfo } from "@vincemakes/kiso-runtime/internal";

const DEFAULT_POLL_MS = 60_000;
const OUTPUT_CAP = 64 * 1024;

interface GhCheck {
	readonly name: string;
	readonly state: string;
	readonly bucket: string; // pass | fail | pending | skipping | cancel
	readonly link?: string;
	readonly workflow?: string;
}

interface GhView {
	readonly headRefOid?: string;
	readonly reviews?: readonly { readonly id: string; readonly state?: string; readonly submittedAt?: string; readonly author?: { readonly login?: string } }[];
	readonly comments?: readonly { readonly id: string; readonly createdAt?: string; readonly author?: { readonly login?: string } }[];
}

export interface GhWaitOptions {
	/** How often `gh` is asked. Default 60 s. */
	readonly pollMs?: number;
	/** The `gh` executable. Default "gh" on PATH; tests point it at a fake. */
	readonly gh?: string;
	/** Where `gh` runs — the workspace, so a bare `pr 207` resolves to this
	 *  repository. Read at each call (the CLI's root is known late). Never
	 *  the process's cwd: that is shared, mutable, and may be gone. */
	readonly cwd: string | (() => string);
	/** A failed probe (no auth, no network, not JSON) — retried at the next
	 *  interval; reported here so a host can show it and a test can see it. */
	readonly onError?: (error: Error) => void;
}

/** `gh <args>` as JSON, with the output capped. */
function gh(bin: string, cwd: string, args: readonly string[], signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = execFile(bin, [...args], { cwd, maxBuffer: OUTPUT_CAP, signal }, (err, stdout) => {
			if (err) return reject(err);
			try {
				resolve(JSON.parse(stdout));
			} catch (e) {
				reject(new Error(`gh ${args[0]} ${args[1]}: not JSON (${(e as Error).message})`));
			}
		});
		child.on("error", reject);
	});
}

function prOf(wait: WaitInfo): { readonly pr: string; readonly repoArgs: readonly string[] } {
	const pr = wait.source.pr;
	if (typeof pr !== "number" && typeof pr !== "string") throw new Error(`${wait.source.kind} needs { pr: <number> }`);
	const repo = wait.source.repo;
	return { pr: String(pr), repoArgs: typeof repo === "string" && repo !== "" ? ["--repo", repo] : [] };
}

/** Poll `probe` every `pollMs` until it returns an event or the signal
 *  aborts. A `gh` failure (no auth, no network) is retried at the next
 *  interval, not fatal — the PR is still there; only our view of it is
 *  late. The first probe runs at once. */
function poll<T>(pollMs: number, signal: AbortSignal, onError: ((error: Error) => void) | undefined, probe: () => Promise<T | null>): Promise<T> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const stop = (): void => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		};
		signal.addEventListener(
			"abort",
			() => {
				stop();
				reject(new Error("aborted"));
			},
			{ once: true },
		);
		const tick = async (): Promise<void> => {
			if (signal.aborted) return;
			try {
				const ev = await probe();
				if (ev !== null) return resolve(ev);
			} catch (err) {
				onError?.(err instanceof Error ? err : new Error(String(err))); // retried next tick
			}
			if (signal.aborted) return;
			timer = setTimeout(() => void tick(), pollMs);
			(timer as { unref?: () => void }).unref?.();
		};
		void tick();
	});
}

const cwdOf = (o: GhWaitOptions): string => (typeof o.cwd === "function" ? o.cwd() : o.cwd);

export function ghChecksDriver(options: GhWaitOptions): WaitDriver {
	const bin = options.gh ?? "gh";
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	return {
		kind: "gh-checks",
		arm: (wait, signal) => {
			const { pr, repoArgs } = prOf(wait);
			return poll(pollMs, signal, options.onError, async () => {
				const cwd = cwdOf(options);
				const view = (await gh(bin, cwd, ["pr", "view", pr, ...repoArgs, "--json", "headRefOid"], signal)) as GhView;
				const checks = (await gh(bin, cwd, ["pr", "checks", pr, ...repoArgs, "--json", "name,state,bucket,link,workflow"], signal)) as GhCheck[];
				if (!Array.isArray(checks) || checks.length === 0) return null; // no checks yet: not a conclusion
				if (checks.some((c) => c.bucket === "pending")) return null;
				const version = typeof view.headRefOid === "string" ? `sha:${view.headRefOid}` : "sha:unknown";
				const ids = checks.map((c) => `${c.name}=${c.bucket}`).sort();
				return {
					eventId: `gh-checks:${pr}:${version}:${ids.join(",")}`,
					payload: { subject: `github:pr#${pr}`, version, checks: checks.map((c) => ({ name: c.name, state: c.state, bucket: c.bucket, ...(c.link !== undefined ? { link: c.link } : {}), ...(c.workflow !== undefined ? { workflow: c.workflow } : {}) })) },
				};
			});
		},
	};
}

export function ghReviewDriver(options: GhWaitOptions): WaitDriver {
	const bin = options.gh ?? "gh";
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	return {
		kind: "gh-review",
		arm: (wait, signal) => {
			const { pr, repoArgs } = prOf(wait);
			let baseline: Set<string> | null = null;
			return poll(pollMs, signal, options.onError, async () => {
				const view = (await gh(bin, cwdOf(options), ["pr", "view", pr, ...repoArgs, "--json", "headRefOid,reviews,comments"], signal)) as GhView;
				const reviews = view.reviews ?? [];
				const comments = view.comments ?? [];
				const ids = new Set([...reviews.map((r) => `review:${r.id}`), ...comments.map((c) => `comment:${c.id}`)]);
				if (baseline === null) {
					// what exists at registration is not news
					baseline = ids;
					return null;
				}
				const fresh = [...ids].filter((id) => !baseline!.has(id)).sort();
				if (fresh.length === 0) return null;
				const version = typeof view.headRefOid === "string" ? `sha:${view.headRefOid}` : "sha:unknown";
				return {
					eventId: `gh-review:${pr}:${fresh.join(",")}`,
					payload: {
						subject: `github:pr#${pr}`,
						version,
						reviews: reviews.filter((r) => fresh.includes(`review:${r.id}`)).map((r) => ({ id: r.id, state: r.state, author: r.author?.login, submittedAt: r.submittedAt })),
						comments: comments.filter((c) => fresh.includes(`comment:${c.id}`)).map((c) => ({ id: c.id, author: c.author?.login, createdAt: c.createdAt })),
					},
				};
			});
		},
	};
}

/** The CLI's drivers, as `tasksFor` registers them. */
export function cliWaitDrivers(options: GhWaitOptions): readonly WaitDriver[] {
	return [ghChecksDriver(options), ghReviewDriver(options)];
}
