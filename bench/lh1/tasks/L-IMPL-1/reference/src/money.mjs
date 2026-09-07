import { exponent } from "./currency.mjs";

/** Amounts are integers of MINOR units for their currency. */
export function parseAmount(text, currency = "USD") {
	const exp = exponent(currency);
	const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
	if (m === null) throw new Error(`bad amount: ${text}`);
	const frac = m[3] ?? "";
	if (frac.length > exp) throw new Error("too many decimals");
	const sign = m[1] === "-" ? -1 : 1;
	return sign * (Number(m[2]) * 10 ** exp + (exp === 0 ? 0 : Number(frac.padEnd(exp, "0"))));
}

export function formatAmount(minor, currency = "USD") {
	const exp = exponent(currency);
	const sign = minor < 0 ? "-" : "";
	const abs = Math.abs(minor);
	if (exp === 0) return `${sign}${abs}`;
	const unit = 10 ** exp;
	return `${sign}${Math.floor(abs / unit)}.${String(abs % unit).padStart(exp, "0")}`;
}

/** Banker's rounding: ties go to the even neighbour. */
export function roundHalfEven(x) {
	const f = Math.floor(x);
	const d = x - f;
	if (d > 0.5) return f + 1;
	if (d < 0.5) return f;
	return f % 2 === 0 ? f : f + 1;
}
