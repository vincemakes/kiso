/**
 * Fixture — one known failure mode, recorded as a playable script + an
 * assertion the kernel must satisfy.
 *
 * This is kiso's answer to "prove the loop is honest": every fixture is a
 * real incident abstracted (uooki production, 2026). A fixture the loop
 * cannot pass is a regression the loop must not ship. Other frameworks
 * advertise features; kiso advertises "verifyable against known failure
 * modes" — because CC's loudest production complaints (reports of done work
 * that never landed, silent tool failures) are exactly these shapes.
 *
 * `assert` receives the FULL trajectory (all events, seq 0..N) once the
 * loop exists. Until then, fixtures carry a `staticCheck` that runs against
 * the raw script — the shape of the failure, before the loop is written to
 * fail it. Loop-integrated assertions land with the loop (M1).
 */

import type { FauxScript } from "../../src/adapters/faux";
import type { Event } from "../../src/protocol/events";
import type { EventInput } from "../../src/kernel/event-log";

export interface Fixture {
	readonly name: string;
	/** Which real incident this abstracts. */
	readonly incident: string;
	readonly script: FauxScript;
	/** Delivery expectations — runs analyzeDelivery over the trajectory. */
	readonly delivery?: { readonly required: boolean; readonly producers: ReadonlySet<string> };
	/** The loop's terminal MUST be one of these for the fixture to pass. */
	readonly requiredTerminal?: readonly string[];
	/**
	 * Static analysis over the script's events — the failure signature.
	 * Returns violation strings; empty = the shape is present as expected.
	 */
	readonly staticCheck?: (events: readonly EventInput[]) => readonly string[];
	/**
	 * Full-trajectory assertion, wired once the loop exists.
	 * Returns violation strings; empty = pass.
	 */
	readonly assert?: (trajectory: readonly Event[]) => readonly string[];
}
