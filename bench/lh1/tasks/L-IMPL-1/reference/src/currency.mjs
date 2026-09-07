const EXPONENTS = { USD: 2, EUR: 2, GBP: 2, JPY: 0, KWD: 3 };

export function isCurrency(s) {
	return typeof s === "string" && /^[A-Z]{3}$/.test(s) && Object.prototype.hasOwnProperty.call(EXPONENTS, s);
}

export function exponent(code) {
	if (!isCurrency(code)) throw new Error(`unknown currency: ${code}`);
	return EXPONENTS[code];
}
