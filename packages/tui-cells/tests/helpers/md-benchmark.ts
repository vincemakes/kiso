/**
 * TUI2-MD — THE ACCEPTANCE CONTENT: the owner's own first real session
 * output (the 0.9.0 repo audit), verbatim. Every construct the round
 * renders, in the mix a real session produced: CJK prose, ## headings,
 * **bold**, nested lists, inline code, a version table.
 *
 * The source document lives OUTSIDE the repo. The tree-wide CJK gate
 * (scripts/check-cjk.mjs) forbids the literal bytes in a tracked file, so
 * every non-ASCII code point below is a \uXXXX escape — the STRING is the
 * verbatim content, the SOURCE is ASCII. A helper, not product code.
 */

export const MD_BENCHMARK = [
	`\u6211\u5168\u9762\u770b\u4e86\u4e00\u904d\u8fd9\u4e2a\u9879\u76ee\uff0c\u5148\u8bf4\u7ed3\u8bba\uff1a**\u9879\u76ee\u5065\u5eb7\u5ea6\u5f88\u9ad8** \u2014\u2014 193 \u4e2a\u6d4b\u8bd5\u6587\u4ef6 / 1507 \u4e2a\u7528\u4f8b\u5168\u90e8\u901a\u8fc7\uff0cCJK/whitespace/smoke \u7b49 gate \u5168\u7eff\uff0cgit \u6811\u5e72\u51c0\uff0cADR`,
	`\u7eaa\u5f8b\u548c\u884c\u6570\u95e8\u69db\u90fd\u6267\u884c\u5f97\u5f88\u597d\u3002\u5728\u8fd9\u4e2a\u57fa\u7840\u4e0a\uff0c\u6211\u627e\u5230\u51e0\u4e2a\u771f\u5b9e\u7684\u4f18\u5316\u70b9\uff0c\u6309\u4f18\u5148\u7ea7\u6392\u5217\uff1a`,
	``,
	`## 1. \u7248\u672c\u5143\u6570\u636e\u6df7\u4e71\uff08\u6700\u5bb9\u6613\u4fee\u3001\u4e5f\u6700\u5bb9\u6613\u88ab\u5751\uff09`,
	``,
	`- \u6839 \`package.json\`\uff1a\`0.1.0\`\uff1b14 \u4e2a workspace\uff08packages/apps/extensions\uff09\uff1a\`0.9.0\`\uff1bREADME \u5934\u90e8\uff1a\`v0.2.0\`\uff1b\u78c1\u76d8\u4e0a\u7684 tarball\uff1a\`1.2.0\``,
	`- \u6839 devDependencies \u8fd8\u628a \`@vincemakes/kiso-core\` / \`-evals\` / provider \u9489\u5728 \`0.1.0\`\uff0c\u4e0e workspace \u7684 \`0.9.0\` \u4e0d\u4e00\u81f4`,
	`- **\u5efa\u8bae**\uff1a\u4ece\u5355\u4e00\u6765\u6e90\u751f\u6210\u7248\u672c\uff0c\u52a0\u4e00\u4e2a check gate \u6821\u9a8c\u5404 package \u7248\u672c\u4e00\u81f4\u3001README \u5934\u90e8\u4e0e\u6700\u65b0 release \u5bf9\u9f50\u3002`,
	``,
	`## 2. TODO.md \u7684 P2 \u6761\u76ee\u5df2\u8fc7\u65f6\uff08\u9648\u5e74\u503a\u52a1\uff09`,
	``,
	`P2 \u5199\u7684\u662f "cache % can render >100%\uff08923% \u590d\u73b0\uff09"\uff0c\u4f46 \`apps/cli/src/chat.ts\` \u7684 E2 (1.3.0) heal\uff08\`canonicalizeUsage\` + \u6bcf provider \u7684 input`,
	`\u7ea6\u5b9a\uff09\u5df2\u7ecf\u5728\u4ee3\u7801\u6ce8\u91ca\u91cc\u660e\u786e\u8bb0\u5f55\u4e86\u8be5\u4fee\u590d\u3002**TODO \u91cc\u8fd9\u6761\u8be5\u79fb\u5165\u5df2\u89e3\u51b3\u8bb0\u5f55**\u3002`,
	``,
	`## 3. TUI resize \u76d1\u542c\u5668\u6cc4\u6f0f\uff08\u6709\u544a\u8b66\u5b9e\u8bc1\uff09`,
	``,
	`\u8dd1\u6d4b\u8bd5\u65f6\u53cd\u590d\u51fa\u73b0 \`MaxListenersExceededWarning: 11 resize listeners added to [Socket]\`\u3002`,
	``,
	`| \u533a\u57df | \u884c\u6570 | \u9884\u7b97 | \u72b6\u6001 |`,
	`|---|---|---|---|`,
	`| core | 1972 | 2000 | \u2713 \u4f59 28 \u884c |`,
	`| cli | 2012 | 1920 | \u8d85 92\uff0creport-only |`,
	`| tui-cells | 1468 | 1280 | \u8d85 188\uff0creport-only |`,
	``,
	`\u5982\u679c\u4f60\u60f3\uff0c\u6211\u53ef\u4ee5\u76f4\u63a5\u52a8\u624b\u4fee **#1\uff08\u7248\u672c\u4e00\u81f4\u6027 + gate\uff09** \u548c **#2\uff08TODO \u66f4\u65b0\uff09**\u3002\u8981\u6211\u505a\u54ea\u4e2a\uff1f`,
	``,
].join("\n");
