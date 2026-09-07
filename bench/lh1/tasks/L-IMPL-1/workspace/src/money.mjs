/** Amounts are integers of minor units (cents). */
export function parseAmount(text) {
	const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
	if (m === null) throw new Error(`bad amount: ${text}`);
	const sign = m[1] === "-" ? -1 : 1;
	const whole = Number(m[2]);
	const frac = (m[3] ?? "").padEnd(2, "0");
	return sign * (whole * 100 + Number(frac));
}

export function formatAmount(minor) {
	const sign = minor < 0 ? "-" : "";
	const abs = Math.abs(minor);
	const whole = Math.floor(abs / 100);
	const frac = String(abs % 100).padStart(2, "0");
	return `${sign}${whole}.${frac}`;
}
