/**
 * DC-58's sibling (the owner, 2026-09-21): the /model panel must say WHO
 * each profile will spend.
 *
 * Two profiles can name the SAME model id and reach two different accounts
 * (`~/.kiso/config.json` is exactly that shape for this owner), so a row
 * that prints only `kind/model` cannot tell the person which one they are
 * about to select. The host comes from the profile's own base URL, and the
 * CURRENT mark follows the PROFILE the session is on — the old
 * `profile.model === agentModel` marked both such rows, or neither, because
 * `agentModel` is sometimes a profile name and sometimes a model id.
 *
 * REAL kiso chat under a pty, faux provider: `/model` writes the durable
 * profile revision without sending a request, which is what lets this assert
 * the panel's bytes without spending one. The confirming enter rides the
 * wall clock (the R1.5 lesson this suite repeats: the panel's rows are
 * written after its status text, so a key fed the moment a needle appears can
 * reach a panel that has not finished painting).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

/** The transcript without its attributes. */
const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** One model id, two accounts: the shape this gate exists for. */
const TWO_ACCOUNTS = {
	models: {
		co: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "PROV_KEY", baseUrl: "https://api.commandcode.ai/provider/v1" },
		ds: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "PROV_KEY", baseUrl: "https://api.deepseek.com" },
	},
};

describe("DC-58's sibling — the /model panel names each profile's provider", () => {
	it("two profiles, one model id: the rows differ by HOST and only the live one is marked current", () => {
		const { dirs, env } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify(TWO_ACCOUNTS)}\n`);
		const raw = ptyRun(["chat", "prov-a", "--model", "co"], { ...env, PROV_KEY: "fake" } as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "/model\r"],
				["takes effect on the next turn", "exit\r"],
			],
			// Enter alone: the cursor opens on the live profile, so this
			// confirms the CURRENT row and the notice below is deterministic.
			delays: [[2.6, "\r"]],
		});
		const t = plain(raw);
		expect(t, "the live profile's host is on its row").toContain("openai-compat/deepseek-v4-flash @api.commandcode.ai");
		expect(t, "and the other account's row carries ITS host — the two are not one row").toContain("openai-compat/deepseek-v4-flash @api.deepseek.com");
		expect(t, "the session is on `co`, so `co` is current").toMatch(/@api\.commandcode\.ai[^\n]*current/);
		expect(t, "and `ds` is NOT — the model id alone would have marked both").not.toMatch(/@api\.deepseek\.com[^\n]*current/);
		expect(t, "the switch notice names the account it will spend").toContain("model → co (deepseek-v4-flash @api.commandcode.ai)");
		expect(t, "and the status row keeps the MODEL only — the owner's second pass").not.toContain("deepseek-v4-flash@api.commandcode.ai");
	}, 240_000);
});
