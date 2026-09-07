import { StatzError } from "./errors.mjs";

export const USAGE = "usage: statz <summary|top|export> <file> [options]\n";

const usage = () => Object.assign(new StatzError(1, "usage"), { usage: true });
const oneOf = (values, flag) => (v) => {
	if (!values.includes(v)) throw new StatzError(1, `bad value for ${flag}`);
	return v;
};

const FLAGS = {
	summary: {
		"--unit": { key: "unit", parse: (v) => v },
		"--sort": { key: "sort", parse: oneOf(["name", "mean"], "--sort") },
	},
	top: {
		"--n": {
			key: "n",
			parse: (v) => {
				if (!/^[1-9][0-9]*$/.test(v)) throw new StatzError(1, "bad value for --n");
				return Number(v);
			},
		},
		"--by": { key: "by", parse: oneOf(["mean", "max"], "--by") },
	},
	export: {
		"--format": { key: "format", parse: oneOf(["json", "csv"], "--format") },
	},
};

const DEFAULTS = {
	summary: { unit: undefined, sort: "name" },
	top: { n: 3, by: "mean" },
	export: { format: "json" },
};

/** The only flag parsing: left to right, first problem wins. */
export function parseArgs(argv) {
	const [command, file, ...rest] = argv;
	if (!command || !file || !Object.hasOwn(FLAGS, command)) throw usage();
	const options = { ...DEFAULTS[command] };
	const flags = FLAGS[command];
	for (let i = 0; i < rest.length; i += 1) {
		const flag = rest[i];
		if (!Object.hasOwn(flags, flag)) throw new StatzError(1, `unknown option ${flag}`);
		if (i + 1 >= rest.length) throw new StatzError(1, `missing value for ${flag}`);
		options[flags[flag].key] = flags[flag].parse(rest[++i]);
	}
	return { command, file, options };
}
