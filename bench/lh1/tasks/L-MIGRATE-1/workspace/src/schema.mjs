/** The rule-file schema (v1). `validateRule` returns every problem it finds. */
const KNOWN = new Set(["id", "description", "extends", "severity", "when", "enabled", "pattern", "message", "fix", "options", "tags", "examples", "deprecated"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateRule(name, data) {
	if (!isObject(data)) return ["not an object"];
	const errors = [];
	const has = (k) => Object.hasOwn(data, k);
	for (const key of Object.keys(data)) if (!KNOWN.has(key)) errors.push(`unknown key ${key}`);
	if (typeof data.id !== "string" || data.id === "") errors.push("id must be a non-empty string");
	else if (data.id !== name.replace(/\.json$/, "")) errors.push("id must match the file name");
	if (typeof data.description !== "string") errors.push("description must be a string");
	if (has("extends") && typeof data.extends !== "string") errors.push("extends must be a string");
	if (has("severity") && ![0, 1, 2].includes(Number(data.severity))) errors.push("severity must be 0, 1 or 2");
	if (has("when") && typeof data.when !== "string") errors.push("when must be a string");
	if (has("enabled") && data.enabled !== "yes" && data.enabled !== "no") errors.push("enabled must be yes or no");
	if (has("pattern") && typeof data.pattern !== "string") errors.push("pattern must be a string");
	if (has("message") && typeof data.message !== "string") errors.push("message must be a string");
	if (has("fix") && data.fix !== null && typeof data.fix !== "string" && !isObject(data.fix)) errors.push("fix must be null, a string or an object");
	if (has("options") && !isObject(data.options)) errors.push("options must be an object");
	if (has("tags") && !(Array.isArray(data.tags) && data.tags.every((t) => typeof t === "string"))) errors.push("tags must be an array of strings");
	if (has("examples") && !(isObject(data.examples) && Array.isArray(data.examples.bad) && Array.isArray(data.examples.good))) errors.push("examples must have bad and good arrays");
	if (has("deprecated") && typeof data.deprecated !== "boolean") errors.push("deprecated must be a boolean");
	if (!has("extends")) for (const k of ["severity", "when", "pattern", "message"]) if (!has(k)) errors.push(`missing ${k}`);
	return errors;
}
