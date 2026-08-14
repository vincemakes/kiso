import { formatUser } from "./user.js";
import { reportLine } from "./report.js";

const u = { name: "Ada", email: "ada@example.com" };
const flag = process.argv[2];
if (!flag) {
  console.log(formatUser(u));
  console.log(reportLine(u, 3));
  process.exit(0);
}
if (flag.startsWith("--")) {
  // an unwired flag must be LOUD — the silent exit-0 junk output was a
  // bench trap (findings E6-F2/F4/F5); exit 1 with a clear message.
  console.error(`flag ${flag} not implemented`);
  process.exit(1);
}
console.log(formatUser(u));
console.log(reportLine(u, 3));
