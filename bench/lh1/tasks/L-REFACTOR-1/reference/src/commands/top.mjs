import { aggregate } from "../stats.mjs";
import { fmt, pad } from "../format.mjs";

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function run(rows, options) {
	const scored = aggregate(rows).map((g) => ({ name: g.name, score: options.by === "max" ? g.max : g.mean }));
	scored.sort((a, b) => b.score - a.score || byName(a, b));
	const picked = scored.slice(0, options.n);
	const width = Math.max(0, ...picked.map((p) => p.name.length));
	return picked.map((p) => `${pad(p.name, width)}  ${fmt(p.score)}\n`).join("");
}
