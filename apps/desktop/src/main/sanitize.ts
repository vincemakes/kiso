/**
 * The desktop's own tool-argument sanitizer. The default one is a filter
 * for a hosted product's tool card (it drops prose keys and cuts strings at
 * 200 characters); the person on the other end of this stream is the
 * person whose files these are, and a diff needs the whole of oldText and
 * newText. So keys stay and strings are only capped at a size no edit
 * comes near, to keep one frame from carrying a whole generated file.
 *
 * The projection hands the sanitizer the arguments alone, never the tool's
 * name, so it cannot treat `edit_file` differently from `shell`: the cap is
 * the same for every tool.
 */
export const DESKTOP_MAX_ARG_CHARS = 32_768;
const MAX_DEPTH = 8;

export function desktopSanitize(input: unknown, depth = 0): unknown {
	if (typeof input === "string") return input.length > DESKTOP_MAX_ARG_CHARS ? `${input.slice(0, DESKTOP_MAX_ARG_CHARS)}…[${input.length - DESKTOP_MAX_ARG_CHARS} more chars]` : input;
	if (input === null || typeof input !== "object") return input;
	if (depth >= MAX_DEPTH) return Array.isArray(input) ? "[…]" : "{…}";
	if (Array.isArray(input)) return input.map((v) => desktopSanitize(v, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) out[key] = desktopSanitize(value, depth + 1);
	return out;
}
