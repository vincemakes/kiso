import { readFileSync } from "node:fs";
import { fmt, pad } from "./util.mjs";

function fail(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function readRows(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw fail(2, `cannot read ${path}`);
	}
	const lines = text.split("\n");
	if (lines[0] !== "name,value,unit,tags") throw fail(3, "bad header");
	const rows = [];
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === "") continue;
		const parts = line.split(",");
		if (parts.length !== 4) throw fail(3, `bad line ${i + 1}`);
		if (parts[1].trim() === "" || !Number.isFinite(Number(parts[1]))) throw fail(3, `bad value on line ${i + 1}`);
		rows.push({ name: parts[0], value: Number(parts[1]), unit: parts[2], tags: parts[3] === "" ? [] : parts[3].split(";") });
	}
	return rows;
}

function median(sorted) {
	const n = sorted.length;
	return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function aggregate(rows) {
	const byName = new Map();
	for (const row of rows) {
		let group = byName.get(row.name);
		if (!group) {
			group = { name: row.name, values: [], unit: row.unit };
			byName.set(row.name, group);
		}
		group.values.push(row.value);
	}
	const out = [];
	for (const group of byName.values()) {
		let sum = 0;
		for (const v of group.values) sum += v;
		const sorted = [...group.values].sort((a, b) => a - b);
		out.push({
			name: group.name,
			count: group.values.length,
			min: sorted[0],
			max: sorted[sorted.length - 1],
			mean: sum / group.values.length,
			p50: median(sorted),
			unit: group.unit,
		});
	}
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}

export function summary(path, options) {
	let rows = readRows(path);
	if (options.unit) rows = rows.filter((r) => r.unit === options.unit);
	const groups = aggregate(rows);
	if (options.sort === "mean") groups.sort((a, b) => b.mean - a.mean || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const header = ["name", "count", "min", "max", "mean", "p50", "unit"];
	const cells = groups.map((g) => [g.name, String(g.count), fmt(g.min), fmt(g.max), fmt(g.mean), fmt(g.p50), g.unit]);
	const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i].length)));
	return [header, ...cells].map((r) => `${r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd()}\n`).join("");
}
