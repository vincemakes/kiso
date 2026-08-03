/**
 * Shared API-error → StructuredError mapping for both adapters.
 *
 * Classification by status code, never by regex over message text
 * (ADR-0005). 529 is the Cloudflare overload code most OpenAI-compat
 * providers proxy raw.
 */

import type { StructuredError } from "./protocol/events.js";

export function mapApiError(status: number | undefined, message: string): StructuredError {
	const withStatus = (e: Omit<StructuredError, "status">): StructuredError =>
		status !== undefined ? { ...e, status } : e;

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
