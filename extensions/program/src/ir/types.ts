/**
 * The logical program (research): what the model WRITES is a dataflow of declared
 * tool calls with explicit dependencies; what the runtime DOES with it (order, overlap,
 * rate) is the runtime's. The meaning of a program is its SEQUENTIAL execution: nodes in
 * listed order, one at a time. An optimised execution is correct iff it is
 * observationally equal to that (invariants I17-I19, kiso-doc/program-invariants.md).
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Pure expressions, evaluated by the host (never by model-written code). `$` is the item inside `filter`. */
export type Expr =
	| { lit: Json }
	| { ref: string; path?: (string | number)[] }
	| { arr: Expr[] }
	| { obj: Record<string, Expr> }
	| { op: "not" | "len" | "isEmpty"; a: Expr }
	| { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "and" | "or" | "add"; a: Expr; b: Expr }
	| { op: "concat"; parts: Expr[] }
	| { op: "join"; list: Expr; sep: string }
	| { op: "pluck"; list: Expr; key: string }
	| { op: "filter"; list: Expr; where: Expr }
	| { op: "sum"; list: Expr }
	| { op: "if"; cond: Expr; then: Expr; else: Expr };

interface Base { id: string; after?: string[]; when?: Expr }
export type Node =
	| (Base & { kind: "call"; tool: string; args: Expr })
	| (Base & { kind: "let"; value: Expr })
	| (Base & { kind: "map"; over: Expr; as: string; body: Node[]; yield: Expr })
	| (Base & { kind: "until"; max: number; init: Expr; as: string; body: Node[]; next: Expr; done: Expr });

export interface Program { nodes: Node[]; output: Expr }

/** What a tool call does to the world, declared by a TRUSTED host (never inferred from a name or a description). */
export type Effect = { kind: "pure" } | { kind: "read" | "write"; keys: string[] | "*" } | { kind: "unknown" };

export interface CallResult { ok: boolean; value?: Json; error?: string }

export type Status = "pending" | "running" | "done" | "failed" | "skipped";

export interface RunOptions {
	mode: "sequential" | "parallel";
	call(tool: string, args: Json): Promise<CallResult>;
	/** `args` is undefined while they are not computable yet; the answer must then be conservative (a wildcard key). */
	effects(tool: string, args: Json | undefined): Effect;
	maxConcurrency?: number;
	maxCalls?: number;
}

export interface RunResult {
	ok: boolean;
	output?: Json;
	error?: string;
	/** every node instance, by dotted position: status and result */
	nodes: Record<string, { id: string; status: Status; value?: Json }>;
	/** calls in the order they were STARTED */
	started: { tool: string; args: Json }[];
	maxInFlight: number;
}
