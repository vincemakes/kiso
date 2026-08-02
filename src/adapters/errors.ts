/**
 * Shared API-error → StructuredError mapping for both adapters.
 *
 * Classification by status code, never by regex over message text
 * (ADR-0005). 529 is the Cloudflare overload code most OpenAI-compat
 * providers proxy raw.
 */

import type { StructuredError } from "../protocol/events";

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
		case 500:
		case 502:
		case 503:
		case 504:
			return withStatus({ code: "api_5xx", retryable: true, message });
		case 400:
			return withStatus({ code: "invalid_request", retryable: false, message });
		default:
			return withStatus({ code: "unknown", retryable: false, message });
	}
}
