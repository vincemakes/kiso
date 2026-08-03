/**
 * Fixture: TERMINAL LIES — the model reports done work that never landed.
 *
 * Incident (uooki production, 2026): a long-document turn called
 * `document_create` twice, the chat asserted "已创建文档产物", and the
 * Canvas stayed empty — the tool was an inline Markdown table that never
 * reaches the canvas, and all three delivery guards were blind to it
 * because it was absent from the producer registry. The turn was reported
 * "completed".
 *
 * The kernel-side shape: text claims delivery, no `delivers` tool ran, and
 * the terminal says "completed". The fix the fixture pins: a run whose
 * trajectory contains a delivery claim with zero producer calls is NOT a
 * clean `completed` — the harness's delivery tracker must see the signal.
 */

import type { Event } from "@kiso/core";
import { analyzeDelivery } from "@kiso/core";
import type { Fixture } from "./types.js";

export const terminalLies: Fixture = {
	name: "terminal-lies",
	incident:
		"uooki long-document turn: model claimed '已创建文档产物', canvas stayed empty, turn reported completed (document_create trap, 2026-07-31)",
	delivery: {
		required: true,
		producers: new Set(["create_artifact", "docx_create"]),
	},
	script: [
		{
			events: [
				{ type: "text_start" },
				{ type: "text_delta", text: "我已经生成了一份完整的调研报告，并已交付到画布上。" },
				{ type: "text_end" },
				{ type: "stop", reason: "end_turn" },
			],
		},
	],
	staticCheck: (events) => {
		const violations: string[] = [];
		const claimsDelivery = events.some(
			(e) => e.type === "text_delta" && /交付|已生成|completed|delivered/i.test(e.text),
		);
		const produced = events.some((e) => e.type === "tool_call_end" && e.name === "create_artifact");
		if (claimsDelivery && !produced) {
			// This IS the failure shape: a claim with zero producers.
			return [];
		}
		violations.push(
			"script no longer reproduces the incident: a delivery claim must exist with zero producer calls",
		);
		return violations;
	},
	// Loop-integrated: the claim exists, the ledger says zero deliveries.
	assert: (trajectory: readonly Event[]) => {
		const verdict = analyzeDelivery(trajectory, {
			required: true,
			producers: new Set(["create_artifact", "docx_create"]),
		});
		const violations: string[] = [];
		if (!verdict.claimedInText) violations.push("the claim must still be in the text");
		if (verdict.completedProducers.length !== 0) violations.push("no producer may have completed");
		if (verdict.passed) {
			violations.push("delivery must FAIL: claimed delivery with zero completed producers");
		}
		return violations;
	},
	requiredTerminal: ["completed"], // the loop is honest; the VERDICT is the harness's
};
