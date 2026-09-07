import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A rule file that cannot be used. `file` is the file name, `reason` the bare message. */
export class RuleError extends Error {
	constructor(file, reason) {
		super(`${file}: ${reason}`);
		this.file = file;
		this.reason = reason;
	}
}

const LEVELS = ["off", "warn", "error"];
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s !== "");

function readRaw(dir) {
	const raw = new Map();
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
		let data;
		try {
			data = JSON.parse(readFileSync(join(dir, name), "utf8"));
		} catch (err) {
			throw new RuleError(name, `invalid JSON (${err.message})`);
		}
		if (typeof data.id !== "string" || data.id === "") throw new RuleError(name, "missing id");
		if (data.id !== name.slice(0, -5)) throw new RuleError(name, `id ${data.id} does not match the file name`);
		raw.set(data.id, data);
	}
	return raw;
}

/** The version-2 form → the normalized rule every consumer sees. A rule that
 *  `extends` another inherits the parent's normalized optional fields it omits.
 *  The `deprecated` tag is the marker, not a tag: it becomes the flag. */
function normalize(name, data, raw, seen = []) {
	if (!Object.hasOwn(data, "schema")) throw new RuleError(name, "missing schema");
	if (data.schema !== 2) throw new RuleError(name, `unsupported schema ${data.schema}`);
	let base = {};
	if (Object.hasOwn(data, "extends")) {
		if (typeof data.extends !== "string" || !raw.has(data.extends)) throw new RuleError(name, `extends unknown rule ${data.extends}`);
		if (seen.includes(data.extends)) throw new RuleError(name, "extends cycle");
		base = normalize(`${data.extends}.json`, raw.get(data.extends), raw, [...seen, data.id]);
	}
	const has = (k) => Object.hasOwn(data, k);
	if (!LEVELS.includes(data.level)) throw new RuleError(name, "level must be off, warn or error");
	if (!isStringList(data.files)) throw new RuleError(name, "files must be a non-empty array of strings");
	if (typeof data.enabled !== "boolean") throw new RuleError(name, "enabled must be a boolean");
	const match = has("match") && data.match !== null && typeof data.match === "object" ? data.match : {};
	if (typeof match.pattern !== "string") throw new RuleError(name, "missing pattern");
	try {
		new RegExp(match.pattern);
	} catch {
		throw new RuleError(name, "invalid pattern");
	}
	if (typeof match.message !== "string" || match.message === "") throw new RuleError(name, "missing message");
	return {
		id: data.id,
		description: typeof data.description === "string" ? data.description : (base.description ?? ""),
		extends: has("extends") ? data.extends : null,
		level: data.level,
		files: data.files,
		enabled: data.enabled,
		pattern: match.pattern,
		message: match.message,
		fix: has("fix") ? data.fix : (base.fix ?? null),
		options: has("options") ? data.options : (base.options ?? {}),
		tags: has("tags") ? data.tags.filter((t) => t !== "deprecated") : (base.tags ?? []),
		examples: has("examples") ? data.examples : (base.examples ?? { bad: [], good: [] }),
		deprecated: has("tags") ? data.tags.includes("deprecated") : (base.deprecated ?? false),
	};
}

/** Every rule under `dir`, normalized, sorted by id. */
export function loadRules(dir) {
	const raw = readRaw(dir);
	const rules = [];
	for (const [id, data] of raw) rules.push(normalize(`${id}.json`, data, raw));
	rules.sort(byId);
	return rules;
}
