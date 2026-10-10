const j = (r) => JSON.parse(r.content[0].text);
const names = ["Brass Heron", "Quiet Engine", "Glass Orchard", "Salt Lantern", "Hollow Drum", "Night Ferry"];
const p = j(await tools.mcp__studio__create_project({ name: "Atlas", budget_credits: 200 }));
const subs = await Promise.all(names.map((n) => tools.mcp__studio__add_subject({ project_id: p.project_id, name: n }).then(j)));
const assets = await Promise.all(subs.map((s) => tools.mcp__studio__generate_asset({ subject_id: s.subject_id, style: "noir" }).then(j)));
const revised = new Set();
for (let round = 0; round < 5; round++) {
  const rs = await Promise.all(assets.map((a) => tools.mcp__studio__analyze_asset({ asset_id: a.asset_id }).then(j)));
  const bad = rs.filter((r) => !r.passes);
  if (!bad.length) break;
  bad.forEach((b) => revised.add(b.asset_id));
  await Promise.all(bad.map((b) => tools.mcp__studio__revise_asset({ asset_id: b.asset_id, instruction: "fix " + b.issues.join(" ") })));
}
const list = j(await tools.mcp__studio__list_assets({ project_id: p.project_id, compact: true }));
return { assets: list.assets, revised: [...revised] };
