import { parseAmount } from "./money.mjs";

/** One posting per line: `date | account | amount | memo`; `;` comments. */
export function parseJournal(text) {
	const entries = [];
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];
		const line = raw.trim();
		if (line === "" || line.startsWith(";")) continue;
		const parts = line.split(" | ").map((p) => p.trim());
		if (parts.length < 3 || parts.length > 4) throw new Error(`line ${i + 1}: expected 3 or 4 fields`);
		const [date, account, amountText, memo = ""] = parts;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`line ${i + 1}: bad date ${date}`);
		if (!/^[a-z][a-z0-9:-]*$/.test(account)) throw new Error(`line ${i + 1}: bad account ${account}`);
		entries.push({ date, account, amount: parseAmount(amountText), memo });
	}
	return entries;
}
