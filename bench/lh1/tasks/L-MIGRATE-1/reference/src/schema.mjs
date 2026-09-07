/** The rule-file schema (version 2). `validateRule` returns every problem it finds. */
const KNOWN = new Set(["schema", "id", "description", "extends", "level", "files", "enabled", "match", "fix", "options", "tags", "examples"]);
const REQUIRED = ["id", "description", "level", "files", "enabled", "match"];
const LEVELS = ["off", "warn", "error"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

export function validateRule(name, data) {
	if (!isObject(data)) return ["not an object"];
	const errors = [];
	const has = (k) => Object.hasOwn(data, k);
	if (data.schema !== 2) errors.push("schema must be 2");
	for (const key of Object.keys(data)) if (!KNOWN.has(key)) errors.push(`unknown key ${key}`);
	if (has("id") && (typeof data.id !== "string" || data.id === "")) errors.push("id must be a non-empty string");
	else if (has("id") && data.id !== name.replace(/\.json$/, "")) errors.push("id must match the file name");
	if (has("description") && typeof data.description !== "string") errors.push("description must be a string");
	if (has("extends") && typeof data.extends !== "string") errors.push("extends must be a string");
	if (has("level") && !LEVELS.includes(data.level)) errors.push("level must be off, warn or error");
	if (has("files") && !(isStringList(data.files) && data.files.length > 0 && data.files.every((s) => s !== ""))) errors.push("files must be a non-empty array of strings");
	if (has("enabled") && typeof data.enabled !== "boolean") errors.push("enabled must be a boolean");
	if (has("match") && !(isObject(data.match) && typeof data.match.pattern === "string" && typeof data.match.message === "string")) errors.push("match must have pattern and message strings");
	if (has("fix") && data.fix !== null && typeof data.fix !== "string" && !isObject(data.fix)) errors.push("fix must be null, a string or an object");
	if (has("options") && !isObject(data.options)) errors.push("options must be an object");
	if (has("tags") && !isStringList(data.tags)) errors.push("tags must be an array of strings");
	if (has("examples") && !(isObject(data.examples) && Array.isArray(data.examples.bad) && Array.isArray(data.examples.good))) errors.push("examples must have bad and good arrays");
	for (const k of REQUIRED) if (!has(k)) errors.push(`missing ${k}`);
	return errors;
}
