import { readFileSync } from "node:fs";

function fail(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

// The third copy of the reader (blank lines skipped, like summary's).
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

// The second copy of the aggregator.
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

export function exportRows(path, options) {
	const groups = aggregate(readRows(path));
	if (options.format === "csv") {
		const lines = ["name,count,min,max,mean,p50,unit"];
		for (const g of groups) {
			lines.push([g.name, g.count, g.min.toFixed(2), g.max.toFixed(2), g.mean.toFixed(2), g.p50.toFixed(2), g.unit].join(","));
		}
		return `${lines.join("\n")}\n`;
	}
	return `${JSON.stringify(groups, null, 2)}\n`;
}
