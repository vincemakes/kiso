import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/index.js";
import { shellTool } from "@vincemakes/kiso-tools-node";

/**
 * PR-1d: CONTENT-PRESENCE REGRESSION GUARDS for the tested clause combination.
 *
 * WHAT THESE ARE. The five texts below were measured TOGETHER, as one
 * combination, against the published prompt. The guards exist so the
 * combination cannot lose one of its parts silently in a later edit.
 *
 * WHAT THEY ARE NOT, and the first draft of this comment got both wrong:
 *
 *   - NO SENTENCE HERE IS SHOWN EFFECTIVE ON ITS OWN. The round measured a
 *     combination. PR-1's arm A carried the tool texts alone and scored 1/5
 *     on the cell that discriminates, which shows those texts are not
 *     sufficient — it does not isolate any of the five.
 *   - NO CAUSATION IS ASSIGNED TO WHAT WAS LEFT OUT. The sections this
 *     prompt does not carry (the environment block, the rewritten Tool
 *     discipline / Working / Voice) were never isolated either. A previous
 *     round that included them cost more; which of them did that is unknown.
 *   - A REGEX CANNOT GUARANTEE MEANING. Adding a negation can preserve every
 *     match here and reverse the instruction. These assertions catch
 *     DELETION and gross rewording. They do not certify that the text still
 *     says what it said.
 *
 * If a clause must genuinely change, this file is re-pinned with a DECLARED
 * SUPERSESSION naming what changed and the measurement that justifies it —
 * never quietly updated to match new text.
 */

/** clause -> the facts it must state, each as an alternation. */
const CLAUSES: ReadonlyArray<{
	readonly name: string;
	readonly measuredWith: string;
	readonly text: () => string;
	readonly facts: ReadonlyArray<readonly [string, RegExp]>;
}> = [
	{
		name: "the reach section",
		measuredWith: "the combination: weather 0/5 -> 5/5 (PR-1 arm B); reach 15/18 -> 18/18 (PR-1d)",
		text: () => SYSTEM_PROMPT,
		facts: [
			["it names the workspace tools", /read_file[\s\S]{0,80}list_dir[\s\S]{0,80}search_text/],
			["shell reaches THIS MACHINE and the NETWORK", /this machine and the network/i],
			["it names the network by an example the model can act on", /curl|HTTP/],
			["a one-command question is ANSWERED BY RUNNING IT", /answered by running it/i],
			["ask_user is for a decision that is the human's", /ask_user[\s\S]{0,60}(theirs|human)/i],
		],
	},
	{
		name: "the scope sentence",
		measuredWith: "the combination: branch-deletion HOLDs 3/3 -> 0/3 (arm B'); delbranch 0/3 -> 3/3 (PR-1d)",
		text: () => SYSTEM_PROMPT,
		facts: [
			["an authorization covers what it NAMES", /authorization covers what it/i],
			["the unnamed cases are enumerated", /which files[\s\S]{0,60}which branches[\s\S]{0,60}whether to push/i],
			["the instruction is to ASK BEFORE ACTING", /ask before acting/i],
		],
	},
	{
		name: "the delivery sentence",
		measuredWith: "the combination: delivery HOLDs 2/3 -> 0/3 (arm B''); deliver 0/3 -> 3/3 (PR-1d)",
		text: () => SYSTEM_PROMPT,
		facts: [
			["delivering means committing LOCALLY and STOPPING", /committing locally and\s*\n?\s*stopping/i],
			["pushing, publishing and sending are the named acts", /pushing, publishing or sending/i],
			["they happen only when the HUMAN NAMES it", /only when the human\s*\n?\s*names it/i],
		],
	},
	{
		name: "the shell tool description",
		measuredWith: "the combination; arm A carried the tool texts ALONE and was 1/5",
		text: () => shellTool({ workspace: "/tmp" } as never).description ?? "",
		facts: [
			["it names what shell is FOR", /builds, tests, git/i],
			["package managers and HTTP are named", /package managers[\s\S]{0,40}curl/i],
			["system queries are named", /system queries/i],
			["approval is possible, not mandatory", /may be asked to approve/i],
		],
	},
	{
		name: "the shell prompt snippet",
		measuredWith: "the combination",
		text: () => shellTool({ workspace: "/tmp" } as never).promptSnippet ?? "",
		facts: [
			["it does NOT narrow shell to system commands only", /^(?!.*real system commands only).*$/s],
			["it says ANY command the task needs", /any command the task needs/i],
			["curl and system queries are named", /curl[\s\S]{0,30}system queries/i],
		],
	},
];

describe("PR-1d: the tested clause combination is still present", () => {
	for (const clause of CLAUSES) {
		for (const [fact, pattern] of clause.facts) {
			it(`${clause.name}: ${fact}`, () => {
				const t = clause.text();
				expect(t, `${clause.name} is present at all`).not.toBe("");
				expect(t, `${clause.name} must state: ${fact}\n  measured with: ${clause.measuredWith}\n  got:\n${t}`).toMatch(pattern);
			});
		}
	}
});
