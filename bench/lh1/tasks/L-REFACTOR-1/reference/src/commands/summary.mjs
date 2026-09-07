import { aggregate } from "../stats.mjs";
import { fmt, table } from "../format.mjs";

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function run(rows, options) {
	const kept = options.unit ? rows.filter((r) => r.unit === options.unit) : rows;
	const groups = aggregate(kept);
	if (options.sort === "mean") groups.sort((a, b) => b.mean - a.mean || byName(a, b));
	return table(
		["name", "count", "min", "max", "mean", "p50", "unit"],
		groups.map((g) => [g.name, String(g.count), fmt(g.min), fmt(g.max), fmt(g.mean), fmt(g.p50), g.unit]),
	);
}
