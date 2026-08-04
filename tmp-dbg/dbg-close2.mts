import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "t", version: "1" });
const transport = new StdioClientTransport({ command: "node", args: ["/Users/vinve/Desktop/devv/kiso/extensions/mcp/tests/fake-server.mjs"], env: { PATH: process.env.PATH, HOME: process.env.HOME, LOGNAME: process.env.LOGNAME, USER: process.env.USER, SHELL: process.env.SHELL, TERM: process.env.TERM } });
await client.connect(transport);
await client.close();
console.log("closed");
