/** The only place statistics are computed. */
export function median(sorted) {
	const n = sorted.length;
	return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Groups rows by name (file order kept inside a group, so sums stay
 *  bit-identical) and returns the groups sorted by name. */
export function aggregate(rows) {
	const groups = new Map();
	for (const row of rows) {
		let group = groups.get(row.name);
		if (!group) {
			group = { name: row.name, values: [], unit: row.unit };
			groups.set(row.name, group);
		}
		group.values.push(row.value);
	}
	const out = [];
	for (const group of groups.values()) {
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
	out.sort(byName);
	return out;
}
