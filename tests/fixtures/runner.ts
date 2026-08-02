/**
 * Fixture runner — flattens a script to its raw events and runs the static
 * checks. Loop integration (trajectory + requiredTerminal) lands in M1.
 */

import type { Event } from "../../src/protocol/events";
import type { Fixture } from "./types";

export function flattenScript(fixture: Fixture): readonly Omit<Event, "seq">[] {
	return fixture.script.flatMap((turn) => turn.events);
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
