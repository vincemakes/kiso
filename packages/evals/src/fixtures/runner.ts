/**
 * Fixture runner — flattens a script to its raw events and runs the static
 * checks. Loop integration (trajectory + requiredTerminal) lands in M1.
 */

import type { EventInput } from "@vincemakes/kiso-core";
import type { Fixture } from "./types.js";

export function flattenScript(fixture: Fixture): readonly EventInput[] {
	// W18: the delay pseudo-event is a harness timing directive consumed by
	// the faux stream — never a model event, so the static checks must not
	// see it (the flat view is the MODEL's event stream).
	return fixture.script.flatMap((turn) => turn.events.filter((ev): ev is EventInput => ev.type !== "delay"));
}

export interface FixtureResult {
	readonly name: string;
	readonly violations: readonly string[];
}

export function runStaticFixture(fixture: Fixture): FixtureResult {
	const events = flattenScript(fixture);
	const violations = fixture.staticCheck ? fixture.staticCheck(events) : [];
	return { name: fixture.name, violations };
}
