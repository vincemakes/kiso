import { isCurrency } from "./currency.mjs";
import { parseAmount } from "./money.mjs";

/** One posting per line: `date | account | amount | memo [| CCY]`; `;` comments;
 *  `; default-currency: EUR` before any posting sets the default. */
export function parseJournal(text) {
	const entries = [];
	let defaultCurrency = "USD";
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (line === "") continue;
		if (line.startsWith(";")) {
			const h = /^;\s*default-currency:\s*([A-Z]{3})\s*$/.exec(line);
			if (h !== null && entries.length === 0) {
				if (!isCurrency(h[1])) throw new Error(`unknown currency: ${h[1]}`);
				defaultCurrency = h[1];
			}
			continue;
		}
		const parts = line.split(" | ").map((p) => p.trim());
		if (parts.length < 3 || parts.length > 5) throw new Error(`line ${i + 1}: expected 3 to 5 fields`);
		const [date, account, amountText, memo = "", currencyField] = parts;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`line ${i + 1}: bad date ${date}`);
		if (!/^[a-z][a-z0-9:-]*$/.test(account)) throw new Error(`line ${i + 1}: bad account ${account}`);
		const currency = currencyField ?? defaultCurrency;
		if (!isCurrency(currency)) throw new Error(`unknown currency: ${currency}`);
		entries.push({ date, account, amount: parseAmount(amountText, currency), memo, currency });
	}
	return entries;
}
