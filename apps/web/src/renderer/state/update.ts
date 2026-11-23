import type { UpdateReply } from "../../shared/update.js";

/** The page's doors to kiso web's check for a newer release of itself (`/desk/update`). */
async function call(body?: Record<string, unknown>): Promise<UpdateReply> {
	const response = await fetch("/desk/update", { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	if (!response.ok) throw new Error(`update ${response.status}`);
	return (await response.json()) as UpdateReply;
}

export const fetchUpdate = (): Promise<UpdateReply> => call();
/** Close the pill for one release. */
export const hideUpdate = (version: string): Promise<UpdateReply> => call({ hide: version });
export const switchUpdateCheck = (enabled: boolean): Promise<UpdateReply> => call({ enabled });
export const checkUpdateNow = (): Promise<UpdateReply> => call({ check: true });
