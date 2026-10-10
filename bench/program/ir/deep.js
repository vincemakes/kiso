const j = (r) => JSON.parse(r.content[0].text);
const names = ["Copper Gull", "Tide Clerk", "Ash Piano", "Velvet Lamp", "Stone Violin", "Reed Cartographer", "Marrow Clock", "Pale Harbor", "Iron Orchid", "Dust Archive", "Lantern Fox", "Kelp Bishop"];
const p = j(await tools.mcp__studio__create_project({ name: "Meridian", budget_credits: 250 }));
const subs = await Promise.all(names.map((n) => tools.mcp__studio__add_subject({ project_id: p.project_id, name: n }).then(j)));
const assets = await Promise.all(subs.map((s) => tools.mcp__studio__generate_asset({ subject_id: s.subject_id, style: "noir" }).then(j)));
for (let round = 0; round < 6; round++) {
  const rs = await Promise.all(assets.map((a) => tools.mcp__studio__analyze_asset({ asset_id: a.asset_id }).then(j)));
  const bad = rs.filter((r) => !r.passes);
  if (!bad.length) break;
  await Promise.all(bad.map((b) => tools.mcp__studio__revise_asset({ asset_id: b.asset_id, instruction: "fix " + b.issues.join(" ") })));
}
await tools.mcp__studio__arrange_board({ project_id: p.project_id, asset_ids: assets.map((a) => a.asset_id), layout: "grid" });
const ap = j(await tools.mcp__studio__request_approval({ project_id: p.project_id, summary: "ready" }));
await tools.mcp__studio__finalize_project({ project_id: p.project_id, approval_token: ap.approval_token });
const w = j(await tools.mcp__studio__wallet_balance({ project_id: p.project_id }));
return { spent: w.spent };
