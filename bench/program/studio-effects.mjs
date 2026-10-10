/**
 * Effects of the mock studio server's tools, declared BY THE HOST (never read from a name or a
 * description). Assumptions a real host would own: credit charges commute while the budget is
 * sufficient (the tasks' budgets are), ids are opaque. Anything not listed is `unknown` = barrier.
 */
export const studioEffects = (tool, args) => {
	const t = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
	const a = args !== null && typeof args === "object" && !Array.isArray(args) ? args : undefined;
	const key = (k, field) => (a && a[field] !== undefined ? [`${k}:${String(a[field])}`] : "*");
	switch (t) {
		case "create_project": return { kind: "write", keys: ["projects"] };
		case "add_subject": return { kind: "write", keys: key("project", "project_id") };
		case "generate_asset": return { kind: "write", keys: key("subject", "subject_id") };
		case "revise_asset": return { kind: "write", keys: key("asset", "asset_id") };
		case "analyze_asset": case "get_asset": return { kind: "read", keys: key("asset", "asset_id") };
		case "list_subjects": case "list_assets": case "get_subject": case "wallet_balance": return { kind: "read", keys: "*" };
		case "arrange_board": case "request_approval": case "finalize_project": return { kind: "write", keys: key("project", "project_id") };
		default: return { kind: "unknown" };
	}
};
