/**
 * @vincemakes/kiso-client — the typed client for a hosted kiso session.
 *
 * Over the wire protocol only: run, resume, abort, approve, the snapshot,
 * and a stream that reconnects with Last-Event-ID and never repeats an
 * event. Browser and Node; depends on `@vincemakes/kiso-protocol` alone.
 */

export { ClientError, createClient, KisoClient, SessionClient } from "./client.js";
export type { ClientEvent, ClientOptions, ConnectionState, EventsOptions, RunStreamOptions } from "./client.js";
export { parseSseBlock, readSse } from "./sse.js";
export type { SseFrame } from "./sse.js";
