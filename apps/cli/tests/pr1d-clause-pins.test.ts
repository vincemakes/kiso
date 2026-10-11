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

/**
 * DECLARED SUPERSESSION — 2026-10-11, the P1.3 prompt (kiso-doc
 * report-p13-confirm-and-fidelity-2026-10-11, kit-p13 dc0bc8e;
 * report-shipgate-p11o1-interim-2026-10-11; the scope matrix in the gate D
 * note). Three of the five clauses are replaced; the two shell-tool
 * clauses are unchanged.
 *
 *   - THE REACH SECTION. Was: the tool-by-tool reach list and "a request
 *     one command can answer is answered by running it". Now: one
 *     capability paragraph (shell reaches this machine and the network,
 *     including git, package managers and HTTP; a factual question is
 *     answered from tool evidence, not guessed and not claimed
 *     unavailable). The workspace tools and ask_user are named by the
 *     composed tool table, not by the prompt. Measured: the Capability
 *     Fidelity matrix (18 reach prompts in 6 classes + 3 ask + 3 no-ask,
 *     n=2) P1.3 48/48 against 0.49.0 48/48 — the weather cell PR-1
 *     discriminated on is in it. P1.1, which dropped the reach facts
 *     without a replacement, scored weather 1/3: the reason this clause
 *     is pinned at all.
 *   - THE SCOPE SENTENCE. Was: "an authorization covers what it names …
 *     ask before acting". Now: necessary workspace changes are in scope;
 *     ask only for decisions that require the user; no remote or
 *     irreversible action unless explicitly requested. Measured: the
 *     PR-1d scope class rebuilt (unnamed log / export / branch clean-up
 *     over a protected item, plus the named-path mirror), n=3 per arm:
 *     P1.3 12/12, 0.49.0 12/12, the protected item never destroyed. NOT
 *     preserved: the ask rate on the unnamed cells fell 8/9 -> 4/9 (P1.3
 *     acts on the clearly safe part instead).
 *   - THE DELIVERY SENTENCE. REVERSED, by the owner's ruling of
 *     2026-10-11 (workspace edits are implied by the task; repository
 *     history and remote actions need explicit intent). Was: delivering
 *     means committing locally and stopping. Now: share / deliver / hand
 *     over / get ready do not authorize a commit, push, publish or send;
 *     the changes stay in the workspace. Measured: the restraint matrix
 *     (7 phrasings, n=3) P1.3 21/21 against 0.49.0 9/21 — 0.49.0 commits
 *     on all four unnamed phrasings, by its own rule.
 */

/** clause -> the facts it must state, each as an alternation. */
const CLAUSES: ReadonlyArray<{
	readonly name: string;
	readonly measuredWith: string;
	readonly text: () => string;
	readonly facts: ReadonlyArray<readonly [string, RegExp]>;
}> = [
	{
		name: "the reach paragraph",
		measuredWith: "Capability Fidelity 48/48 (P1.3) vs 48/48 (0.49.0); P1.1 without it: weather 1/3",
		text: () => SYSTEM_PROMPT,
		facts: [
			["shell reaches THIS MACHINE and the NETWORK", /shell can access this machine and the network/i],
			["it names git, package managers and HTTP", /git, package managers, and HTTP/],
			["a factual question is answered from TOOL EVIDENCE", /factual questions[\s\S]{0,80}tool evidence or an available tool/i],
			["never guessed, never claimed unavailable", /rather than guessing or claiming the information is unavailable/i],
		],
	},
	{
		name: "the scope paragraph",
		measuredWith: "the PR-1d scope class rebuilt: 12/12 (P1.3) vs 12/12 (0.49.0); ask rate 4/9 vs 8/9",
		text: () => SYSTEM_PROMPT,
		facts: [
			["workspace changes are in the task's scope", /necessary workspace changes are within the scope of the requested task/i],
			["asking is for decisions that are the USER's", /ask the user only for decisions that require the user/i],
			["remote and irreversible acts need an explicit request", /do not commit, push, publish, send, or perform other remote or irreversible actions unless explicitly requested/i],
		],
	},
	{
		name: "the delivery paragraph",
		measuredWith: "restraint 21/21 (P1.3) vs 9/21 (0.49.0); the owner's commit-semantics ruling, 2026-10-11",
		text: () => SYSTEM_PROMPT,
		facts: [
			["share / deliver / hand over / get ready are NAMED", /share, deliver, hand over, or get work ready/i],
			["they do not by themselves authorize the remote acts", /do not by themselves authorize a commit, push, publish, or send/i],
			["only an explicitly named action is performed", /only when the user explicitly names the action/i],
			["otherwise the changes STAY IN THE WORKSPACE", /leave the changes in the workspace/i],
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
