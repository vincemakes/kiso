/**
 * L3 — real JSON Schema validation of tool arguments (Phase B).
 *
 * `Tool.parameters` was always declared to be a JSON Schema the kernel
 * validates; until Phase B it was only advertised, never enforced. ajv is
 * the core's single runtime dependency (ADR-0023): the alternative —
 * hand-rolling a draft-07 subset — is how schemas silently stop meaning
 * what they say. Validators are compiled once per schema and cached.
 */

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

const ajv = new Ajv({ strict: false });
const cache = new WeakMap<object, ValidateFunction>();

/** Returns a human-readable failure reason, or null when the input is valid. */
export function validateArgs(schema: Readonly<Record<string, unknown>>, input: unknown): string | null {
	let validate = cache.get(schema);
	if (!validate) {
		validate = ajv.compile(schema as object);
		cache.set(schema, validate);
	}
	if (validate(input)) return null;
	const first = validate.errors?.[0];
	if (first) {
		const where = first.instancePath || "/";
		return `${where} ${first.message ?? "is invalid"}`;
	}
	return "arguments failed schema validation";
}
