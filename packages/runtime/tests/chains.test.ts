// ADR-0062 PR 3: the causal chain read from a log, its durable wake budget, the completion notice, held messages.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { ChainBudget, completionMessage, completionNotice, currentChain, reachesFurther, runStarter, startInitiation } from "../src/chains.js";
import { writeMessage, type PeerMessage } from "../src/inbox.js";

const u = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, type: "user_input", content: "x", ...extra }) as unknown as Event;
const peer = (seq: number, rootId: string, from = "k/p", event = "message") => u(seq, { source: "system", via: { kind: "peer", event, from, messageId: `m${seq}`, rootId } });
const tasks = (seq: number) => u(seq, { source: "system", via: { kind: "tasks", items: [{ taskId: "t", transition: "exited" }] } });
const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

describe("currentChain", () => {
	it("a person's line opens a chain; a message carries its chain; a task notice keeps the one before", () => {
		expect(currentChain([], "k/a")).toBe("k/a#0");
		expect(currentChain([u(0)], "k/a")).toBe("k/a#0");
		expect(currentChain([u(0), peer(4, "k/b#2")], "k/a")).toBe("k/b#2");
		expect(currentChain([u(0), peer(4, "k/b#2"), tasks(9)], "k/a")).toBe("k/b#2");
		expect(currentChain([peer(4, "k/b#2"), u(7)], "k/a"), "the person speaks: a new chain").toBe("k/a#7");
	});
});

describe("reachesFurther (the hold)", () => {
	const at = (tier: string, added: string[] = [], folder: string | null = "/w") => ({ tier, added, folder });
	it("two sessions in full access are never held, whatever folders either was given (owner, 2026-11-16)", () => {
		expect(reachesFurther(at("full-access"), at("full-access"))).toBe(false);
		expect(reachesFurther(at("full-access"), at("full-access", ["/elsewhere"]))).toBe(false);
		expect(reachesFurther(at("full-access", ["/a"]), at("full-access", ["/b", "/c"]))).toBe(false);
	});
	it("held when the receiver's mode is wider, or it has a folder the sender lacks, or its mode is unknown", () => {
		expect(reachesFurther(at("default"), at("full-access"))).toBe(true);
		expect(reachesFurther(at("plan"), at("accept-edits"))).toBe(true);
		expect(reachesFurther(at("default"), at("default", ["/x"]))).toBe(true);
		expect(reachesFurther(at("default"), at("mystery"))).toBe(true);
	});
	it("held when the receiver's own folder is one the sender cannot reach, in the same mode (finding G1)", () => {
		expect(reachesFurther(at("default", [], "/repo-a"), at("default", [], "/repo-b"))).toBe(true);
		expect(reachesFurther(at("accept-edits", [], "/repo-a"), at("accept-edits", [], "/repo-a-sibling"))).toBe(true);
		expect(reachesFurther(at("default", [], "/repo-a"), at("default", [], null)), "a folder that cannot be read: equality is not shown").toBe(true);
		expect(reachesFurther(at("default", [], null), at("default", [], "/repo-b"))).toBe(true);
	});
	it("not held when the sender reaches the receiver's folder: the same one, one inside it, or one it was added", () => {
		expect(reachesFurther(at("default", [], "/repo-a"), at("default", [], "/repo-a"))).toBe(false);
		expect(reachesFurther(at("default", [], "/repo"), at("default", [], "/repo/pkg"))).toBe(false);
		expect(reachesFurther(at("default", ["/repo-b"], "/repo-a"), at("default", [], "/repo-b"))).toBe(false);
		expect(reachesFurther(at("default", [], "/repo/pkg"), at("default", [], "/repo")), "the receiver's folder holds the sender's: wider").toBe(true);
	});
	it("full access across folders is still never held (owner, 2026-11-16)", () => {
		expect(reachesFurther(at("full-access", [], "/repo-a"), at("full-access", [], "/repo-b"))).toBe(false);
		expect(reachesFurther(at("full-access", [], null), at("full-access", [], null))).toBe(false);
	});
	it("not held when the receiver reaches no further", () => {
		expect(reachesFurther(at("full-access"), at("default"))).toBe(false);
		expect(reachesFurther(at("default", ["/x"]), at("default", ["/x"]))).toBe(false);
	});
});

describe("ChainBudget", () => {
	it("allows 20 wakes per chain, then none, and a new instance (a restart) does not refill it", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-cb-"));
		const b = new ChainBudget(dir);
		for (let i = 0; i < 20; i++) expect(b.take("k/a#0")).toBe(true);
		expect(b.take("k/a#0")).toBe(false);
		expect(new ChainBudget(dir).take("k/a#0"), "after a restart").toBe(false);
		expect(new ChainBudget(dir).take("k/a#9"), "another chain has its own").toBe(true);
	});
});

describe("completionNotice", () => {
	const end = (kind: string) => ({ seq: 99, type: "terminal", outcome: { kind } }) as unknown as Event;
	const reply = (text: string) => [{ seq: 50, type: "assistant_start" }, { seq: 51, type: "text_delta", text }] as unknown as Event[];
	it("owed for the first run and for a run that took the parent's message; not for the person's own runs", () => {
		const base = { parent: "k/p", tasksRunning: false, waiting: false };
		expect(completionNotice({ ...base, run: [u(0), ...reply("done"), end("completed")], firstRun: true })).toEqual({ state: "finished", excerpt: "done" });
		expect(completionNotice({ ...base, run: [u(10), ...reply("x"), end("completed")], firstRun: false })).toBeNull();
		expect(completionNotice({ ...base, run: [u(10), peer(11, "k/p#0"), ...reply("x"), end("completed")], firstRun: false })?.state).toBe("finished");
		expect(completionNotice({ ...base, run: [u(10), peer(11, "k/q#0", "k/q"), ...reply("x"), end("completed")], firstRun: false }), "another session's message: no").toBeNull();
	});
	it("says how the run ended, never 'finished' for a failure or work left running", () => {
		const base = { parent: "k/p", firstRun: true, waiting: false };
		expect(completionNotice({ ...base, tasksRunning: false, run: [u(0), end("error")] })?.state).toBe("failed");
		expect(completionNotice({ ...base, tasksRunning: true, run: [u(0), end("completed")] })?.state).toBe("ended with tasks still running");
		expect(completionNotice({ ...base, tasksRunning: false, waiting: true, run: [u(0), end("completed")] })?.state).toBe("waiting on you");
	});
	it("the excerpt: a reply up to 4,000 characters whole; a longer one cut there, saying so and where the rest is", () => {
		const base = { parent: "k/p", firstRun: true, waiting: false, tasksRunning: false };
		const excerpt = (text: string) => completionNotice({ ...base, run: [u(0), ...reply(text), end("completed")] })?.excerpt;
		expect(excerpt("short reply")).toBe("short reply");
		expect(excerpt("y".repeat(4000)), "exactly the cap: whole").toBe("y".repeat(4000));
		const cut = excerpt("y".repeat(5000))!;
		expect(cut.startsWith("y".repeat(4000)) && !cut.startsWith("y".repeat(4001))).toBe(true);
		expect(cut.endsWith("\n\n(cut; the full reply is in that session — message it to ask)")).toBe(true);
		const wide = excerpt("😀".repeat(4000))!; // 16,000 bytes: cut by bytes too, so the notice fits the 16 KB inbox message
		expect(Buffer.byteLength(wide) < 12_100 && wide.endsWith("message it to ask)") && !wide.includes("\uFFFD")).toBe(true);
	});
});

// the excerpt read from real logs: an agent run with a tool call, not an imagined sequence (the log carries no assistant_start)
describe("the excerpt is the child's last reply, from its real log", () => {
	const look = defineTool({ name: "look", description: "look", parameters: { type: "object" }, execute: async () => ({ content: "seen", isError: false }) });
	const logOf = async (script: unknown[]): Promise<readonly Event[]> => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cx-")));
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [look] as never, adapter: createFauxProvider(script as never) });
		const session = await agent.session({ id: "c" });
		for await (const _ of session.run("do it")) void _;
		return session.log.all;
	};
	const narrate = (text: string, id: string) => ({ events: [{ type: "text_delta", text }, { type: "tool_call_end", callId: id, name: "look", input: {} }, { type: "stop", reason: "tool_use" }] });
	const excerptOf = (run: readonly Event[]) => completionNotice({ run, firstRun: true, parent: "k/p", tasksRunning: false, waiting: false })!.excerpt;
	const NARRATION = "Let me look at the importer first. ".repeat(10);

	it("a run with tool calls: a 3,919-character reply whole, with none of the narration before the calls", async () => {
		const final = "f".repeat(3919);
		const run = await logOf([narrate(NARRATION, "c1"), narrate(NARRATION, "c2"), say(final)]);
		expect(run.some((e) => e.type === "assistant_start"), "the real log has no assistant_start").toBe(false);
		expect(run.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("").length).toBeGreaterThan(4000);
		expect(excerptOf(run)).toBe(final);
	});

	it("a run with tool calls whose reply passes 4,000 characters: cut there, saying so, narration still out", async () => {
		const cut = excerptOf(await logOf([narrate(NARRATION, "c1"), say("r".repeat(4500))]));
		expect(cut).toBe(`${"r".repeat(4000)}\n\n(cut; the full reply is in that session — message it to ask)`);
	});

	it("a run that fails after a tool's result, with nothing said since: the text before it, never an empty notice", async () => {
		const run = await logOf([narrate("Checking the importer before I change it.", "c1")]); // the script ends: the next request fails
		expect(run.at(-1)).toMatchObject({ type: "terminal" });
		expect(run.map((e) => e.type).lastIndexOf("tool_result")).toBeGreaterThan(run.map((e) => e.type).lastIndexOf("text_delta"));
		const notice = completionNotice({ run, firstRun: true, parent: "k/p", tasksRunning: false, waiting: false })!;
		expect(notice.state).toBe("failed");
		expect(notice.excerpt).toBe("Checking the importer before I change it.");
	});

	it("a run with no tool call: its whole text, as before", async () => {
		const run = await logOf([{ events: [{ type: "text_delta", text: "All " }, { type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] }]);
		expect(excerptOf(run)).toBe("All done.");
	});
});

describe("delivery with a budget and a hold", () => {
	const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ messageId: id, from: "k/s", fromTitle: "S", text: id, files: [], rootId: "k/s#0", at: 1, ...extra });
	it("a held message is never delivered; a spent chain does not wake, its message waits for the next run", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cd-")));
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([say("One.")] as never) });
		const session = await agent.session({ id: "r" });
		await writeMessage(store.root, "r", msg("held", { held: true }));
		await writeMessage(store.root, "r", msg("waits"));
		let woke = false;
		session.usePeers({ root: store.root, onWake: () => void (woke = true), mayWake: () => false });
		expect(woke, "the chain's budget is spent").toBe(false);
		expect(session.pokePeers(), "and the sender is told it waits").toBe("waiting");
		for await (const _ of session.run("the person speaks")) void _;
		const ids = session.log.all.flatMap((e) => (e.type === "user_input" && e.via?.kind === "peer" ? [e.via.messageId] : []));
		expect(ids, "the waiting one rode the person's run; the held one did not").toEqual(["waits"]);
	});
});

// § 14 test 12: who started the turn decides what a start_session call may do (owner, 2026-11-16)
describe("startInitiation", () => {
	const ended = { seq: 1, type: "terminal", reason: "completed" } as unknown as Event;
	const task = u(2, { source: "system", via: { kind: "tasks", ids: ["t1"] } });

	it("the person's own line keeps asked and named; a later run's start counts, not an earlier one's", () => {
		expect(runStarter([u(0)])).toBe("person");
		expect(startInitiation([u(0)], "asked")).toBe("asked");
		expect(startInitiation([u(0)], "named")).toBe("named");
		expect(startInitiation([peer(0, "k/p#0"), ended, u(2)], "asked"), "the person's line after a message's run").toBe("asked");
	});

	it("a run another session's message started refuses the call (null), whatever it asks", () => {
		for (const asked of ["asked", "named", "proposed"] as const) expect(startInitiation([u(0), ended, peer(2, "k/p#0")], asked)).toBeNull();
		expect(runStarter([u(0), ended, peer(2, "k/p#0")])).toBe("message");
	});

	it("a task notice, a completion notice or a run with no line yet turns asked and named into proposed", () => {
		for (const events of [[u(0), ended, task], [u(0), ended, peer(2, "k/p#0", "k/child", "completion")], [u(0), ended]]) {
			expect(runStarter(events), JSON.stringify(events.at(-1))).toBe("other");
			expect(startInitiation(events, "asked")).toBe("proposed");
			expect(startInitiation(events, "named")).toBe("proposed");
		}
	});
});

// The leader's real-browser round (B2): a Work started with `context: "fork"` never woke its parent. A fork's log begins with
// the parent's runs, copied up to the cut, so "the child's first run" is the first run after the cut, not the log's first.
describe("completionMessage for a forked child", () => {
	it("owes its parent a notice for its own first run, the first after the fork's cut", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-forkwake-")));
		const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([say("Parent here."), say("Fork done.")] as never) });
		const parent = await agent.session({ id: "p" });
		for await (const _ of parent.run("Plan the export fix.")) void _;
		const { id, origin } = store.fork("p");
		const child = await agent.session({ id });
		for await (const _ of child.run("Fix the export.")) void _;
		const records = store.load(id);
		expect(records[0]!.runId, "the fork's log opens on the parent's copied run").not.toBe(records.at(-1)!.runId);
		const notice = completionMessage({ records, runId: records.at(-1)!.runId, from: `k/${id}`, fromTitle: "Fork", parent: "k/p", tasksRunning: false, forkAfterSeq: origin.afterSeq });
		expect(notice?.event, "the notice is owed").toBe("completion");
		expect(notice?.text).toContain("Fork done.");
	});
});
