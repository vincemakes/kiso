# sums

A tiny HTTP service. It listens on the port written in `.port`.

- `GET /health` → `ok`
- `GET /sum?a=<n>&b=<n>` → `{"sum": <a + b>}`
