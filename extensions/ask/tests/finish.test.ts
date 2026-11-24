/**
 * finish_with_choices (the decision card): offered only to a host that says it draws the card, 2-3 labels of at most 80 cells,
 * and a result tagged with core's END_TURN so the run ends with no further request.
 */
import { describe, expect, it } from "vitest";
import { END_TURN, validateArgs } from "@vincemakes/kiso-core";
import createAskExtension, { FINISH_PARAMETERS } from "../dist/kiso-ask.mjs";

const names = async (ui?: object) => ((await createAskExtension(ui as never)).tools ?? []).map((t) => t.name);
const ask = async () => undefined;

describe("finish_with_choices", () => {
	it("is offered only where the host draws the card; ask_user keeps its own gate", async () => {
		expect(await names()).toEqual([]);
		expect(await names({ ask })).toEqual(["ask_user"]);
		expect(await names({ cards: true })).toEqual(["finish_with_choices"]);
		expect(await names({ ask, cards: true })).toEqual(["ask_user", "finish_with_choices"]);
	});

	it("takes 2-3 labels, each 1-80 cells, and an optional recommended flag", () => {
		const why = (input: unknown) => validateArgs(FINISH_PARAMETERS, input);
		expect(why({ choices: ["a", "b"] })).toBeNull();
		expect(why({ choices: ["a", "b", "c"], recommended: false })).toBeNull();
		expect(why({ choices: ["a"] })).not.toBeNull();
		expect(why({ choices: ["a", "b", "c", "d"] })).not.toBeNull();
		expect(why({ choices: ["a", ""] })).not.toBeNull();
		expect(why({ choices: ["a", "x".repeat(81)] })).not.toBeNull();
		expect(why({ choices: ["a", "b"], recommended: "yes" })).not.toBeNull();
		expect(why({ choices: ["a", "b"], extra: 1 })).not.toBeNull();
	});

	it("its result ends the turn: tagged with core's END_TURN, never an error; the call is allowed without a prompt", async () => {
		const ext = await createAskExtension({ cards: true } as never);
		const tool = ext.tools!.find((t) => t.name === "finish_with_choices")!;
		const result = await tool.execute({ choices: ["a", "b"] }, {} as never);
		expect(result.isError).toBe(false);
		expect(result.tags).toEqual([END_TURN]);
		expect(END_TURN).toBe("end-turn");
		expect(ext.approvals![0]!.decide({ name: "finish_with_choices" } as never, {} as never)).toMatchObject({ action: "allow" });
	});
});
