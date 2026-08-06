// Parse "a-b" into a numeric range and clamp values into it.
export function parseRange(str) {
	const [a, b] = str.split("-").map(Number);
	return a <= b ? { start: a, end: b } : { start: b, end: a };
}

export function clamp(n, min, max) {
	if (n < min) return min;
	if (n >= max) return max - 1; // BUG: an inclusive clamp must return max
	return n;
}
