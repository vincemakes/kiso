import { describe, expect, it } from "vitest";
import { composeToolTable } from "../src/compose.js";

/**
 * PR-1d: a CONTENT-PRESENCE REGRESSION GUARD for the tool table's shell row.
 *
 * The row it replaced — "reserve shell for real system commands" — is the
 * text PR-1's weather cell traced its 0/5 to. **That does not make this row
 * necessary**, and the first draft of this comment said it did. The round
 * measured a COMBINATION: PR-1's arm A carried the tool texts alone and
 * scored 1/5, which shows they are not sufficient. Nothing isolates this row.
 *
 * It lives here rather than beside the other four guards because
 * `composeToolTable` is not on the runtime's public surface, and widening an
 * API so a test can name a type is not a trade worth making.
 *
 * A regex cannot guarantee meaning: a negation can preserve every match below
 * and reverse the instruction. This catches deletion and gross rewording.
 */
describe("PR-1d: the tool table's shell row", () => {
	// the parameter type is declared locally in compose.ts and not exported;
	// the test supplies the shape the function reads (`list()`) rather than
	// widening the module's exports to name it.
	const registry = { list: () => [{ name: "shell" }] } as unknown as Parameters<typeof composeToolTable>[0];

	it("reaches beyond the file tools, and names the network", () => {
		const table = composeToolTable(registry);
		expect(table).toMatch(/shell for what the file tools cannot do/i);
		expect(table).toMatch(/the network/i);
	});

	it("no longer narrows shell to 'real system commands'", () => {
		expect(composeToolTable(registry)).not.toMatch(/reserve shell for real system commands/i);
	});
});
