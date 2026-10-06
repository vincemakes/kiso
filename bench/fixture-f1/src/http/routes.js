import { validateItem } from "../items/validate.js";
import { publish } from "../events/bus.js";

export function routes(repo) {
	return {
		"GET /items": (req) => ({ status: 200, body: repo.list({ page: Number(req.query.page ?? 1), size: req.query.size === undefined ? undefined : Number(req.query.size) }) }),
		"POST /items": (req) => {
			const errors = validateItem(req.body);
			if (errors.length > 0) return { status: 422, body: { errors } };
			repo.save(req.body);
			publish("item.saved", { sku: req.body.sku });
			return { status: 201, body: req.body };
		},
		"DELETE /items/:sku": (req) => {
			if (repo.find(req.params.sku) === undefined) return { status: 404, body: { error: "no such item" } };
			repo.remove(req.params.sku);
			publish("item.deleted", { sku: req.params.sku });
			return { status: 204 };
		},
	};
}
