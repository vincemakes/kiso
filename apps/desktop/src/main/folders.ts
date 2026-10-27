import { statSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";
import { canonicalPath } from "@vincemakes/kiso-code/config";
import { kisoHome } from "@vincemakes/kiso-runtime";
import { Refusal } from "./files.js";

/** A folder the person picked, judged here and never trusted from the page: absolute, there, a folder, and not the kiso home or inside it. Returns its real path. */
export function validateFolder(raw: unknown): string {
	if (typeof raw !== "string" || raw === "" || raw.includes("\0") || !isAbsolute(raw)) throw new Refusal(400, "pick a folder");
	let real: string;
	try {
		real = canonicalPath(raw);
		if (!statSync(real).isDirectory()) throw new Error("not a folder");
	} catch {
		throw new Refusal(400, "that is not a folder that exists");
	}
	if (real === parse(real).root) throw new Refusal(400, "the whole disk is not a project folder");
	const home = canonicalPath(kisoHome());
	if (real === home || real.startsWith(home + sep)) throw new Refusal(400, "the kiso home holds credentials and sessions: pick a project folder");
	return real;
}
