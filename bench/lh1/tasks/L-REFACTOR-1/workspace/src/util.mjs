/** Shared helpers. Only summary uses them; top and export grew their own. */
export function fmt(x) {
	return x.toFixed(2);
}

export function pad(s, width) {
	const str = String(s);
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}
