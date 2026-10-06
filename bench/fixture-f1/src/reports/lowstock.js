import { warn } from "../util/logger.js";

/** Items at or below their reorder level. */
export function lowStock(items, level = 5) {
	const low = items.filter((i) => i.quantity <= level);
	if (low.length > 0) warn("low stock", { count: low.length });
	return low;
}
