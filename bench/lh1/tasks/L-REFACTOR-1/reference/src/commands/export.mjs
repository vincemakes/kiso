import { aggregate } from "../stats.mjs";
import { fmt } from "../format.mjs";

export function run(rows, options) {
	const groups = aggregate(rows);
	if (options.format === "csv") {
		const lines = ["name,count,min,max,mean,p50,unit"];
		for (const g of groups) lines.push([g.name, g.count, fmt(g.min), fmt(g.max), fmt(g.mean), fmt(g.p50), g.unit].join(","));
		return `${lines.join("\n")}\n`;
	}
	return `${JSON.stringify(groups, null, 2)}\n`;
}
