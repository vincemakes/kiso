const subscribers = new Map();
export function subscribe(name, fn) {
	subscribers.set(name, [...(subscribers.get(name) ?? []), fn]);
}
export function publish(name, payload) {
	for (const fn of subscribers.get(name) ?? []) fn(payload);
}
