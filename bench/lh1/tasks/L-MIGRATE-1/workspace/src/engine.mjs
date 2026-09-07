/** The file kind is the lower-cased extension ("" when there is none). */
export function kindOf(path) {
	const m = /\.([A-Za-z0-9]+)$/.exec(path);
	return m ? m[1].toLowerCase() : "";
}

/** The rules that apply to a kind: enabled, not deprecated, not off, and listed for the kind (or `*`). */
export function applicable(rules, kind) {
	return rules.filter((r) => r.enabled && !r.deprecated && r.level !== "off" && (r.files.includes("*") || r.files.includes(kind)));
}

/** Findings for one text, sorted by line then rule id. */
export function check(text, kind, rules) {
	const findings = [];
	const lines = text.split("\n");
	for (const rule of applicable(rules, kind)) {
		const re = new RegExp(rule.pattern);
		lines.forEach((line, i) => {
			if (re.test(line)) findings.push({ ruleId: rule.id, level: rule.level, line: i + 1, message: rule.message });
		});
	}
	findings.sort((a, b) => a.line - b.line || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
	return findings;
}
