import { formatUser } from "./user.js";

export function reportLine(user, count) {
	return `${formatUser(user)}: ${count} commits`;
}
