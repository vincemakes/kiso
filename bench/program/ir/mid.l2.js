// builder style: call() declares a node and returns a lazy handle; nothing runs until the plan is executed
const names = ["Brass Heron", "Quiet Engine", "Glass Orchard", "Salt Lantern", "Hollow Drum", "Night Ferry"];
const p = call("create_project", { name: "Atlas", budget_credits: 200 });
const subs = names.map((n) => call("add_subject", { project_id: p.project_id, name: n }));
const assets = subs.map((s) => call("generate_asset", { subject_id: s.subject_id, style: "noir" }));
const revised = repeatUntil({ max: 5, state: assets }, (cur) => {
  const rs = cur.map((a) => call("analyze_asset", { asset_id: a.asset_id }));
  const bad = rs.filter((r) => !r.passes);
  bad.forEach((b) => call("revise_asset", { asset_id: b.asset_id, instruction: concat("fix ", join(b.issues, " ")) }));
  return { done: isEmpty(bad), collect: bad.map((b) => b.asset_id) };
});
const list = call("list_assets", { project_id: p.project_id, compact: true });
output({ assets: list.assets, revised });
