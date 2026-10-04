import { config } from "../config.js";

export function createRepository(db) {
	return {
		find: (sku) => db.get(sku),
		save: (item) => db.put(item.sku, item),
		remove: (sku) => db.delete(sku),
		/** One page of items. `size` defaults to the listing default and is capped. */
		list({ page = 1, size } = {}) {
			const pageSize = Math.min(size ?? config.listing.defaultPageSize, config.listing.maxPageSize);
			const all = db.all().sort((a, b) => a.sku.localeCompare(b.sku));
			return all.slice((page - 1) * pageSize, page * pageSize);
		},
	};
}
