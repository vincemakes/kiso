// Bench-only policy: every tool auto-allowed — parity with `claude
// --dangerously-skip-permissions` and pi's default. NEVER install outside
// the benchmark sandbox.
export default {
	name: "bench-allow",
	approvals: [{ decide: () => ({ action: "allow" }) }],
};
