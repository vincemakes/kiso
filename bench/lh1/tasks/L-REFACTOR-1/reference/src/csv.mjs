import { StatzError } from "./errors.mjs";

const HEADER = "name,value,unit,tags";

/** The only CSV reader.
 *  `blankLines`: "skip" (whitespace-only lines are ignored) or "reject"
 *  (any blank line other than the file's final newline is `bad line N`) —
 *  the drift between the old readers, preserved as an option. */
export function parseCsv(text, { blankLines = "skip" } = {}) {
	const lines = text.split("\n");
	if (lines[0] !== HEADER) throw new StatzError(3, "bad header");
	if (blankLines === "reject" && lines[lines.length - 1] === "") lines.pop();
	const rows = [];
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (blankLines === "skip" && line.trim() === "") continue;
		const parts = line.split(",");
		if (parts.length !== 4) throw new StatzError(3, `bad line ${i + 1}`);
		if (parts[1].trim() === "" || !Number.isFinite(Number(parts[1]))) throw new StatzError(3, `bad value on line ${i + 1}`);
		rows.push({ name: parts[0], value: Number(parts[1]), unit: parts[2], tags: parts[3] === "" ? [] : parts[3].split(";") });
	}
	return rows;
}
