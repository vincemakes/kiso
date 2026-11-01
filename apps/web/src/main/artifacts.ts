import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Event } from "@vincemakes/kiso-core";
import type { ArtifactRef } from "../shared/frames.js";
import { resolveInside } from "./files.js";

type ToolResultEvent = Extract<Event, { type: "tool_result" }>;

/**
 * What a tool call made that the page can show, each "best effort, never a guess": an image block of its result; an artifact
 * file a successful write or edit touched; or, for a command, a path its text or its output head names that is inside the
 * folder, of an artifact type, exists, and changed at or after the step began. No folder scan, no watcher.
 */

const KINDS: Readonly<Record<string, ArtifactRef["kind"]>> = {
	".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image",
	".html": "page", ".htm": "page", ".md": "doc", ".pdf": "doc", ".csv": "doc",
	".mp4": "media", ".webm": "media", ".mov": "media", ".mp3": "media", ".wav": "media",
};
const NAMED = /[\w@+./-]+\.(?:png|jpe?g|gif|webp|svg|html?|md|pdf|csv|mp4|webm|mov|mp3|wav)\b/gi;
/** a file's clock and the log's may differ by the file system's granularity */
const SLACK_MS = 50;

export const artifactKind = (path: string): ArtifactRef["kind"] | undefined => KINDS[extname(path).toLowerCase()];

/** The call a result answers, as the log has it before the result: the tool, its input, and when it began executing. */
export interface CallInfo {
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly startedAt: number | null;
}

/** `root`: the folder's real path. */
export function artifactsOf(event: ToolResultEvent, workId: string, call: CallInfo | null, root: string): ArtifactRef[] {
	const out: ArtifactRef[] = [];
	const ref = (n: number | string, kind: ArtifactRef["kind"], uri: string, mediaType?: string): void => {
		out.push({ id: `${event.callId}:${n}`, workId, callId: event.callId, kind, uri, ...(mediaType !== undefined ? { mediaType } : {}) });
	};
	if (Array.isArray(event.content))
		event.content.forEach((b, n) => {
			if (b.type === "image" && ((b.sourceType === "base64" && b.data !== undefined) || b.url?.startsWith("https:") === true)) ref(n, "image", `log:${event.seq}/${n}`, b.mediaType);
		});
	if (event.isError || call === null) return out;
	const file = (raw: string, since: number | null): void => {
		const rel = relative(root, isAbsolute(raw) ? raw : resolve(root, raw));
		const kind = artifactKind(rel);
		if (kind === undefined || rel.startsWith("..") || out.some((a) => a.uri === `file:${rel}`)) return;
		try {
			const stat = statSync(resolveInside(root, rel));
			if (stat.isFile() && (since === null || stat.mtimeMs >= since - SLACK_MS)) ref(rel, kind, `file:${rel}`);
		} catch {
			// gone, outside, protected: not shown
		}
	};
	const path = call.input["path"];
	if ((call.name === "write_file" || call.name === "edit_file") && typeof path === "string") file(path, null);
	if (call.name === "shell" && call.startedAt !== null) {
		const text = `${String(call.input["command"] ?? "")}\n${typeof event.content === "string" ? event.content.slice(0, 16_384) : ""}`;
		for (const m of text.matchAll(NAMED)) file(m[0], call.startedAt);
	}
	return out;
}

/**
 * Image blocks of results, read from the session's log: an index of seq to the byte range of its line, built once per log and
 * extended as it grows, so a request reads one event, never the whole log.
 */
export class LogImages {
	readonly #dir: string;
	readonly #logs = new Map<string, { size: number; lines: Map<number, readonly [number, number]> }>();

	constructor(dir: string) {
		this.#dir = dir;
	}

	/** The n-th block of the result at `seq`: its bytes, an https address to pass on, or null. */
	block(sessionId: string, seq: number, n: number): { readonly type: string; readonly bytes: Buffer } | { readonly url: string } | null {
		const file = join(this.#dir, `${sessionId}.jsonl`);
		const at = this.#index(file).get(seq);
		if (at === undefined) return null;
		const event = (JSON.parse(read(file, at[0], at[1]).toString("utf8")) as { event: ToolResultEvent }).event;
		const b = event.type === "tool_result" && Array.isArray(event.content) ? event.content[n] : undefined;
		if (b?.type !== "image") return null;
		if (b.sourceType === "base64" && b.data !== undefined) return { type: b.mediaType ?? "image/png", bytes: Buffer.from(b.data, "base64") };
		return b.url?.startsWith("https:") === true ? { url: b.url } : null;
	}

	#index(file: string): Map<number, readonly [number, number]> {
		let log = this.#logs.get(file);
		const size = statSync(file).size;
		if (log === undefined || size < log.size) this.#logs.set(file, (log = { size: 0, lines: new Map() }));
		if (size > log.size) {
			const chunk = read(file, log.size, size - log.size);
			let from = 0;
			for (let nl = chunk.indexOf(10); nl !== -1; from = nl + 1, nl = chunk.indexOf(10, from)) {
				try {
					const seq = (JSON.parse(chunk.subarray(from, nl).toString("utf8")) as { event: { seq: number } }).event.seq;
					log.lines.set(seq, [log.size + from, nl - from]);
				} catch {
					// a line that is not a record: skipped
				}
			}
			// a line still being written is read next time
			log.size += from;
		}
		return log.lines;
	}
}

function read(file: string, start: number, length: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(Math.max(0, Math.min(length, fstatSync(fd).size - start)));
		readSync(fd, buf, 0, buf.length, start);
		return buf;
	} finally {
		closeSync(fd);
	}
}
