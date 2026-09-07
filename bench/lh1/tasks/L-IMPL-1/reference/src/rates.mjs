import { exponent } from "./currency.mjs";

/** `FROM TO rate` per line; `;` comments. Rates are kept as exact decimals (num/den). */
export function parseRates(text) {
	const table = new Map();
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith(";")) continue;
		const m = /^([A-Z]{3})\s+([A-Z]{3})\s+(\d+)(?:\.(\d+))?$/.exec(line);
		if (m === null) throw new Error(`rates line ${i + 1}: expected FROM TO rate`);
		const frac = m[4] ?? "";
		table.set(`${m[1]}->${m[2]}`, { num: Number(m[3] + frac), den: 10 ** frac.length });
	}
	return table;
}

/** Integer division rounding ties to even — exact, no floating point. */
function divHalfEven(num, den) {
	const neg = num < 0;
	const n = Math.abs(num);
	const q = Math.floor(n / den);
	const r = n - q * den;
	let out = q;
	if (2 * r > den || (2 * r === den && q % 2 === 1)) out = q + 1;
	return neg ? -out : out;
}

/** Minor units of `to` for `minor` units of `from`; identity, direct or inverse rate. */
export function convert(minor, from, to, rates) {
	if (from === to) return minor;
	const expFrom = exponent(from);
	const expTo = exponent(to);
	const direct = rates.get(`${from}->${to}`);
	const inverse = rates.get(`${to}->${from}`);
	if (direct !== undefined) return divHalfEven(minor * direct.num * 10 ** expTo, direct.den * 10 ** expFrom);
	if (inverse !== undefined) return divHalfEven(minor * inverse.den * 10 ** expTo, inverse.num * 10 ** expFrom);
	throw new Error(`no rate: ${from}->${to}`);
}
