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

/** The v1 form → the normalized rule every consumer sees. A rule that
 *  `extends` another inherits the parent's normalized fields it omits. */
function normalize(name, data, raw, seen = []) {
	let base = {};
	if (Object.hasOwn(data, "extends")) {
		if (typeof data.extends !== "string" || !raw.has(data.extends)) throw new RuleError(name, `extends unknown rule ${data.extends}`);
		if (seen.includes(data.extends)) throw new RuleError(name, "extends cycle");
		base = normalize(`${data.extends}.json`, raw.get(data.extends), raw, [...seen, data.id]);
	}
	const has = (k) => Object.hasOwn(data, k);
	const severity = has("severity") ? Number(data.severity) : base.level !== undefined ? LEVELS.indexOf(base.level) : NaN;
	if (![0, 1, 2].includes(severity)) throw new RuleError(name, "severity must be 0, 1 or 2");
	let files;
	if (has("when")) {
		if (typeof data.when !== "string") throw new RuleError(name, "when must be a string");
		files = data.when.trim() === "*" ? ["*"] : data.when.split(",").map((s) => s.trim()).filter(Boolean);
		if (files.length === 0) throw new RuleError(name, "when is empty");
	} else files = base.files ?? ["*"];
	let enabled;
	if (has("enabled")) {
		if (data.enabled !== "yes" && data.enabled !== "no") throw new RuleError(name, "enabled must be yes or no");
		enabled = data.enabled === "yes";
	} else enabled = base.enabled ?? true;
	const pattern = has("pattern") ? data.pattern : base.pattern;
	if (typeof pattern !== "string") throw new RuleError(name, "missing pattern");
	try {
		new RegExp(pattern);
	} catch {
		throw new RuleError(name, "invalid pattern");
	}
	const message = has("message") ? data.message : base.message;
	if (typeof message !== "string" || message === "") throw new RuleError(name, "missing message");
	return {
		id: data.id,
		description: typeof data.description === "string" ? data.description : (base.description ?? ""),
		extends: has("extends") ? data.extends : null,
		level: LEVELS[severity],
		files,
		enabled,
		pattern,
		message,
		fix: has("fix") ? data.fix : (base.fix ?? null),
		options: has("options") ? data.options : (base.options ?? {}),
		tags: has("tags") ? data.tags : (base.tags ?? []),
		examples: has("examples") ? data.examples : (base.examples ?? { bad: [], good: [] }),
		deprecated: has("deprecated") ? data.deprecated === true : (base.deprecated ?? false),
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
