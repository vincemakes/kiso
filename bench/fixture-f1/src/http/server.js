import { createServer } from "node:http";
import { open } from "../db/connection.js";
import { createRepository } from "../items/repository.js";
import { routes } from "./routes.js";
import { info } from "../util/logger.js";

const table = routes(createRepository(open()));
createServer((req, res) => {
	const key = `${req.method} ${new URL(req.url, "http://x").pathname.replace(/^\/items\/[^/]+$/, "/items/:sku")}`;
	const handler = table[key];
	const out = handler === undefined ? { status: 404 } : handler({ query: {}, params: {}, body: {} });
	res.statusCode = out.status;
	res.end(out.body === undefined ? "" : JSON.stringify(out.body));
}).listen(8080, () => info("listening", { port: 8080 }));
