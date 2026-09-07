import { readFileSync } from "node:fs";

function fail(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

// A second copy of the reader. It drifted: a blank line is an error here.
function readRows(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw fail(2, `cannot read ${path}`);
	}
	const lines = text.split("\n");
	if (lines[0] !== "name,value,unit,tags") throw fail(3, "bad header");
	if (lines[lines.length - 1] === "") lines.pop();
	const rows = [];
	for (let i = 1; i < lines.length; i += 1) {
		const parts = lines[i].split(",");
		if (parts.length !== 4) throw fail(3, `bad line ${i + 1}`);
		const value = Number(parts[1]);
		if (parts[1].trim() === "" || !Number.isFinite(value)) throw fail(3, `bad value on line ${i + 1}`);
		rows.push({ name: parts[0], value, unit: parts[2], tags: parts[3] === "" ? [] : parts[3].split(";") });
	}
	return rows;
}

export function top(path, options) {
	const rows = readRows(path);
	const stats = new Map();
	for (const row of rows) {
		let s = stats.get(row.name);
		if (!s) {
			s = { name: row.name, sum: 0, count: 0, max: -Infinity };
			stats.set(row.name, s);
		}
		s.sum += row.value;
		s.count += 1;
		if (row.value > s.max) s.max = row.value;
	}
	const scored = [...stats.values()].map((s) => ({ name: s.name, score: options.by === "max" ? s.max : s.sum / s.count }));
	scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const picked = scored.slice(0, options.n);
	const width = Math.max(0, ...picked.map((p) => p.name.length));
	return picked.map((p) => `${p.name.padEnd(width)}  ${p.score.toFixed(2)}\n`).join("");
}
