/**
 * MD-1 — THE REPORT'S OWN SAMPLES, verbatim.
 *
 * The streaming-markdown comparison (2026-09-11) reproduced the owner's
 * two complaints and four further defects against these exact fixtures:
 * a 5-column and a 6-column CJK table whose cells are long enough that
 * the 6-column one cannot fit 80 columns, a setext pair, an indented
 * code block and a quote carrying a list and a second paragraph. Every
 * MD-1 gate is stated against them, at the widths the report used
 * (80/100/120), so the round's red evidence and its green evidence are
 * about the same bytes.
 *
 * The source document lives OUTSIDE the repo, and the tree-wide CJK gate
 * (scripts/check-cjk.mjs) forbids the literal bytes in a tracked file —
 * so every non-ASCII code point below is a \uXXXX escape. The STRINGS
 * are the verbatim samples; the SOURCE is ASCII. A helper, not product
 * code.
 *
 * A geometry note that every width in the gates accounts for:
 * `MarkdownBlock.render` hands a block `W - 2` and insets every non-empty
 * row by two columns (R13 E3), so "terminal 80" is `W = 78` here.
 */

export const TABLE5 = [
	`| \u7f16\u53f7 | \u5185\u5bb9\u8d44\u4ea7 | \u7528\u9014 | \u9002\u7528\u793e\u533a | \u72b6\u6001 |`,
	`|---|---|---|---|---|`,
	`| 1 | \u521b\u59cb\u4eba\u6545\u4e8b\u957f\u6587 | \u5efa\u7acb\u4fe1\u4efb | \u5c0f\u7ea2\u4e66 | \u5df2\u5b8c\u6210 |`,
	`| 2 | \u4ea7\u54c1\u5bf9\u6bd4\u8868 | \u8f6c\u5316\u51b3\u7b56 | \u77e5\u4e4e | \u8fdb\u884c\u4e2d |`,
	`| 3 | 30\u79d2\u77ed\u89c6\u9891 | \u62c9\u65b0\u66dd\u5149 | \u6296\u97f3 | \u5f85\u6392\u671f |`,
	`| 4 | \u7528\u6237\u8bc1\u8a00\u5408\u96c6 | \u793e\u4f1a\u8bc1\u660e | \u5fae\u4fe1\u793e\u7fa4 | \u5df2\u5b8c\u6210 |`,
	`| 5 | FAQ \u56fe\u5361 | \u964d\u4f4e\u5ba2\u670d\u91cf | \u5168\u6e20\u9053 | \u8fdb\u884c\u4e2d |`,
	`| 6 | \u76f4\u64ad\u56de\u653e\u526a\u8f91 | \u4e8c\u6b21\u5206\u53d1 | B\u7ad9 | \u5f85\u6392\u671f |`,
].join("\n");

export const TABLE6 = [
	`| \u987a\u5e8f | \u5185\u5bb9\u8d44\u4ea7 | \u7528\u9014 | \u9002\u7528\u793e\u533a | \u8d1f\u8d23\u4eba | \u72b6\u6001 |`,
	`|---|---|---|---|---|---|`,
	`| 15 | \u521b\u59cb\u4eba\u6545\u4e8b\u957f\u6587\uff08\u5b8c\u6574\u7248\uff09 | \u5efa\u7acb\u4fe1\u4efb\u4e0e\u54c1\u724c\u8ba4\u77e5 | \u5c0f\u7ea2\u4e66\u3001\u77e5\u4e4e | \u5f20\u4f1f | \u5df2\u5b8c\u6210 |`,
	`| 16 | \u4ea7\u54c1\u529f\u80fd\u5bf9\u6bd4\u8868 | \u63a8\u52a8\u8f6c\u5316\u51b3\u7b56 | \u77e5\u4e4e\u3001\u5fae\u4fe1\u793e\u7fa4 | \u674e\u5a1c | \u8fdb\u884c\u4e2d |`,
	`| 17 | 30\u79d2\u7ad6\u5c4f\u77ed\u89c6\u9891 | \u62c9\u65b0\u4e0e\u66dd\u5149 | \u6296\u97f3\u3001\u89c6\u9891\u53f7 | \u738b\u5f3a | \u5f85\u6392\u671f |`,
].join("\n");

export const SETEXT = [
	`Setext heading`,
	`==============`,
	``,
	`Another setext`,
	`--------------`,
].join("\n");

export const INDENTED = [
	`some prose first`,
	``,
	`    const x = 1;`,
	`    const y = 2;`,
].join("\n");

export const QUOTED = [
	`> A quote with a list:`,
	`> - one`,
	`> - two`,
	`>`,
	`> And a second paragraph.`,
].join("\n");
