// Dates in this repo are always "YYYY/MM/DD" strings with leading zeros.
export function formatDate(year, month, day) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${year}/${pad(month)}/${pad(day)}`;
}
