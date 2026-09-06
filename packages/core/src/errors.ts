/**
 * Shared API-error → StructuredError mapping for both adapters.
 *
 * Classification by status code, never by regex over message text
 * (ADR-0005). 529 is the Cloudflare overload code most OpenAI-compat
 * providers proxy raw.
 */

import type { StructuredError } from "./protocol/events.js";

/** CX-1 F8: `Retry-After` → milliseconds. Integer seconds or an HTTP-date;
 *  anything else — negative, non-finite, a date already past — is
 *  undefined (the kernel falls back to its own backoff). Never shortened:
 *  a wait above the kernel's cap is reported as-is and the kernel stops
 *  rather than retrying early. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
	if (value === null || value === undefined) return undefined;
	const v = value.trim();
	if (v === "") return undefined;
	if (/^\d+$/.test(v)) {
		const ms = Number(v) * 1000;
		return Number.isFinite(ms) ? ms : undefined;
	}
	const at = Date.parse(v);
	if (!Number.isFinite(at)) return undefined;
	const ms = at - now;
	return ms >= 0 ? ms : undefined;
}

export function mapApiError(status: number | undefined, message: string, retryAfterMs?: number): StructuredError {
	const withStatus = (e: Omit<StructuredError, "status">): StructuredError => ({
		...e,
		...(status !== undefined ? { status } : {}),
		...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
	});

	switch (status) {
		case 401:
		case 403:
			return withStatus({ code: "invalid_request", retryable: false, message });
		case 408:
		case 409:
		case 429:
			return withStatus({ code: "rate_limit", retryable: true, message });
		case 529:
			return withStatus({ code: "overloaded", retryable: true, message });
		case 400:
			return withStatus({ code: "invalid_request", retryable: false, message });
		default:
			if (status !== undefined && status >= 500 && status < 600) {
				// D4: every 500-599 is api_5xx and retryable.
				return withStatus({ code: "api_5xx", retryable: true, message });
			}
			return withStatus({ code: "unknown", retryable: false, message });
	}
}
