/** A SKU is three capital letters, a dash, and four digits: ABC-1234. */
export const SKU = /^[A-Z]{3}-\d{4}$/;

export function validateItem(item) {
	const errors = [];
	if (typeof item.sku !== "string" || !SKU.test(item.sku)) errors.push("sku");
	if (!Number.isInteger(item.quantity) || item.quantity < 0) errors.push("quantity");
	if (typeof item.name !== "string" || item.name.trim() === "") errors.push("name");
	return errors;
}
