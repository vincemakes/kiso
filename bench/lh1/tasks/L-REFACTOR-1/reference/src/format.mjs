/** The only number and text formatting. */
export function fmt(x) {
	return x.toFixed(2);
}

export function pad(s, width) {
	const str = String(s);
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Padded columns, two-space gutters, every line right-trimmed. */
export function table(header, rows) {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	return [header, ...rows].map((r) => `${r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd()}\n`).join("");
}
