import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, RuleError } from "../src/loader.mjs";

const dirWith = (files) => {
	const dir = mkdtempSync(join(tmpdir(), "lh1-rules-"));
	for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
	return dir;
};
const v2 = (id, extra = {}) => ({ schema: 2, id, description: `${id} rule`, level: "warn", files: ["js"], enabled: true, match: { pattern: "x", message: "x found" }, ...extra });
const ruleError = (file, reason) => (e) => e instanceof RuleError && e.file === file && e.reason === reason && e.message === `${file}: ${reason}`;

test("hidden: version 1 is retired — a v1 file is refused before any other field check", () => {
	const v1 = { id: "old", description: "an old rule", severity: 2, when: "js", enabled: "yes", pattern: "x", message: "x found" };
	assert.throws(() => loadRules(dirWith({ "old.json": v1 })), ruleError("old.json", "missing schema"));
	assert.throws(() => loadRules(dirWith({ "old.json": { ...v1, schema: 1 } })), ruleError("old.json", "unsupported schema 1"));
	assert.throws(() => loadRules(dirWith({ "old.json": { ...v1, schema: "2" } })), ruleError("old.json", "unsupported schema 2"));
	const { schema, ...noSchema } = v2("bare");
	assert.throws(() => loadRules(dirWith({ "bare.json": noSchema })), ruleError("bare.json", "missing schema"));
});

test("hidden: a v2 file normalizes to the same shape as before", () => {
	const [r] = loadRules(dirWith({ "a.json": v2("a", { fix: "trim", options: { k: 1 }, tags: ["t"], examples: { bad: ["b"], good: ["g"] } }) }));
	assert.deepEqual(r, { id: "a", description: "a rule", extends: null, level: "warn", files: ["js"], enabled: true, pattern: "x", message: "x found", fix: "trim", options: { k: 1 }, tags: ["t"], examples: { bad: ["b"], good: ["g"] }, deprecated: false });
	const [d] = loadRules(dirWith({ "d.json": v2("d") }));
	assert.deepEqual([d.fix, d.options, d.tags, d.examples, d.deprecated], [null, {}, [], { bad: [], good: [] }, false]);
});

test("hidden: the deprecated tag is the marker, not a tag", () => {
	const [r] = loadRules(dirWith({ "z.json": v2("z", { tags: ["security", "deprecated", "modern"] }) }));
	assert.equal(r.deprecated, true);
	assert.deepEqual(r.tags, ["security", "modern"]);
});

test("hidden: extends still inherits the optional keys, including the deprecated marker", () => {
	const dir = dirWith({
		"base.json": v2("base", { level: "off", enabled: false, options: { style: "camel" }, tags: ["naming", "deprecated"], fix: "rename" }),
		"child.json": { schema: 2, id: "child", description: "child", extends: "base", level: "error", files: ["ts"], enabled: true, match: { pattern: "y", message: "y found" } },
		"own.json": { ...v2("own", { extends: "base", tags: ["mine"] }) },
	});
	const byId = Object.fromEntries(loadRules(dir).map((r) => [r.id, r]));
	assert.equal(byId.child.extends, "base");
	assert.deepEqual(byId.child.options, { style: "camel" });
	assert.deepEqual(byId.child.tags, ["naming"]);
	assert.equal(byId.child.deprecated, true);
	assert.equal(byId.child.fix, "rename");
	assert.equal(byId.child.level, "error");
	assert.equal(byId.child.enabled, true);
	assert.deepEqual(byId.own.tags, ["mine"]);
	assert.equal(byId.own.deprecated, false);
	assert.throws(() => loadRules(dirWith({ "c.json": v2("c", { extends: "nope" }) })), ruleError("c.json", "extends unknown rule nope"));
});

test("hidden: the loader's new reasons and the old ones", () => {
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { level: "high" }) })), ruleError("a.json", "level must be off, warn or error"));
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { files: "js,ts" }) })), ruleError("a.json", "files must be a non-empty array of strings"));
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { files: [] }) })), ruleError("a.json", "files must be a non-empty array of strings"));
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { enabled: "yes" }) })), ruleError("a.json", "enabled must be a boolean"));
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { match: { message: "m" } }) })), ruleError("a.json", "missing pattern"));
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { match: { pattern: "(" , message: "m" } }) })), ruleError("a.json", "invalid pattern"));
	assert.throws(() => loadRules(dirWith({ "a.json": v2("a", { match: { pattern: "x", message: "" } }) })), ruleError("a.json", "missing message"));
	assert.throws(() => loadRules(dirWith({ "b.json": v2("a") })), ruleError("b.json", "id a does not match the file name"));
	assert.throws(() => loadRules(dirWith({ "a.json": "{ nope" })), (e) => e instanceof RuleError && e.file === "a.json" && e.reason.startsWith("invalid JSON ("));
});
