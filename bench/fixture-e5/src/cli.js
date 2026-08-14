import { formatUser } from "./user.js";
import { reportLine } from "./report.js";

const u = { name: "Ada", email: "ada@example.com" };
console.log(formatUser(u));
console.log(reportLine(u, 3));
