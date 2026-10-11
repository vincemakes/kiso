/**
 * The core's tests import the kernel from SOURCE; the runtime's `seedLog` is built against the core's build, so two EventLog classes exist and the type system
 * (rightly) refuses to mix them. This adapter hands the runtime's one seeding implementation the source EventLog. It adds no encoder: `seedLog` and
 * `messagesToEvents` live in @vincemakes/kiso-runtime and nowhere else.
 */
import { seedLog as seed } from "@vincemakes/kiso-runtime";
import { EventLog } from "../src/kernel/event-log.js";
import type { Message } from "../src/protocol/messages.js";

export const seedLog = (messages: readonly Message[], log: EventLog = new EventLog()): EventLog => seed(messages, log);
