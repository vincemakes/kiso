import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(readFileSync(new URL("./.port", import.meta.url), "utf8").trim());

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/health") {
		res.end("ok");
		return;
	}
	if (url.pathname === "/sum") {
		const a = url.searchParams.get("a") ?? "0";
		const b = url.searchParams.get("b") ?? "0";
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ sum: a + b }));
		return;
	}
	res.statusCode = 404;
	res.end("not found");
});

server.listen(port, "127.0.0.1", () => console.log(`sums listening on ${port}`));
