/**
 * safe-defaults — the reference extension (E1).
 *
 * Allow the cheap read-only tools outright; deny the most dangerous shell
 * commands (git stash / git reset / git checkout -- / rm -rf) with a
 * reason the model sees; everything else is asked of the human.
 *
 * Install: put this file (or a symlink to it) at ~/.kiso/extensions/ —
 * kiso scans that directory at startup (KISO_EXTENSIONS_DIR overrides).
 *
 * The contract (packages/runtime/src/extensions.ts): the default export is
 * the extension, or a factory returning it. `name` must be unique per
 * installation; a broken file or a duplicate name fails the process LOUDLY
 * at startup. Verdicts compose deny > ask > allow across all loaded
 * policies: any deny wins, else any ask goes to the human, only an
 * all-allow chain auto-approves. A durable decision survives kill -9 —
 * the policy never re-runs for an already-decided call.
 */
export default {
	name: "safe-defaults",
	approvals: [
		{
			decide(call) {
				if (
					call.name === "read_file" ||
					call.name === "list_dir" ||
					call.name === "search_text" ||
					call.name === "read_skill" || // (5): local user-installed docs — trust level same as read_file
					call.name === "mcp__status" || // finding #10 round: zero-arg read-only status query — trust level same as read_file
					call.name === "todo_set" // round 6 (the todo round): pure session state — the echo lives in the event log, nothing external
				) {
					return { action: "allow" };
				}
				if (
					call.name === "shell" &&
					/\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf/.test(String(call.input.command ?? ""))
				) {
					return { action: "deny", reason: "destructive command — refused by the safe-defaults policy" };
				}
				return { action: "ask" };
			},
		},
	],
};
