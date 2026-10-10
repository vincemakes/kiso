const names = ["Copper Gull", "Tide Clerk", "Ash Piano", "Velvet Lamp", "Stone Violin", "Reed Cartographer", "Marrow Clock", "Pale Harbor", "Iron Orchid", "Dust Archive", "Lantern Fox", "Kelp Bishop"];
const p = call("create_project", { name: "Meridian", budget_credits: 250 });
const subs = names.map((n) => call("add_subject", { project_id: p.project_id, name: n }));
const assets = subs.map((s) => call("generate_asset", { subject_id: s.subject_id, style: "noir" }));
const fixed = repeatUntil({ max: 6, state: assets }, (cur) => {
  const rs = cur.map((a) => call("analyze_asset", { asset_id: a.asset_id }));
  const bad = rs.filter((r) => !r.passes);
  bad.forEach((b) => call("revise_asset", { asset_id: b.asset_id, instruction: concat("fix ", join(b.issues, " ")) }));
  return { done: isEmpty(bad) };
});
const board = call("arrange_board", { project_id: p.project_id, asset_ids: assets.map((a) => a.asset_id), layout: "grid" }, { after: fixed });
const ap = call("request_approval", { project_id: p.project_id, summary: "ready" }, { after: board });
const fin = call("finalize_project", { project_id: p.project_id, approval_token: ap.approval_token });
const w = call("wallet_balance", { project_id: p.project_id }, { after: fin });
output({ spent: w.spent });
