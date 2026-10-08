#!/usr/bin/env node
/**
 * null-calibration.mjs <a.json> <b.json> [--resamples=N] [--seed=S] [--margin=0.2]
 * — what a NULL paired set says about the gate's resolution (BM-1 §1 and
 * Amendment 1's method, made a script so the next route's calibration is
 * not re-derived by hand).
 *
 * Both arms are the SAME binary, so every pair's delta is noise. Rows pair
 * by (task, run) exactly as paired-compare.mjs pairs them (paired-rows.mjs
 * output). Read:
 *
 *   dCost / dWall   per pair, (a − b) / b on cost-weighted and on wall
 *   median, sd      of the pair deltas
 *   bootstrap       N resamples of the pairs WITH replacement (seeded —
 *                   bench/rng.mjs; the same seed gives the same numbers);
 *                   the distribution of the resampled median, and of its
 *                   absolute value: p90 / p95 / p99
 *   resolves        p95(|median|) of the cost delta ≤ the margin: a gate at
 *                   this n and this margin falsely blocks a null diff about
 *                   5% of the time or less
 *   nFor            if it does not resolve: the n at which it would,
 *                   projected by the median's 1/√n scaling — a projection,
 *                   labelled as one, never a measurement
 *
 * It judges nothing about a product. Exit 0 always (a calibration has no
 * verdict to fail); the JSON is the record.
 */
import { readFileSync } from "node:fs";
import { isMain } from "../scripts/is-main.mjs";
import { rng } from "./rng.mjs";

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const sd = (xs) => {
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const cost = (r) => r.costWeighted ?? r.cost_weighted;
const round = (x) => Math.round(x * 10000) / 10000;

export function calibrate(aRows, bRows, { resamples = 10000, seed = "null-calibration", margin = 0.2 } = {}) {
	const key = (r) => `${r.task}-${r.run}`;
	const b = new Map(bRows.map((r) => [key(r), r]));
	const pairs = aRows.filter((r) => b.has(key(r))).map((r) => ({ id: key(r), a: r, b: b.get(key(r)) }));
	const dCost = pairs.map((p) => (cost(p.a) - cost(p.b)) / cost(p.b));
	const dWall = pairs.map((p) => (p.a.wall - p.b.wall) / p.b.wall);
	const n = pairs.length;
	const r = rng(seed);
	const boot = (ds) => {
		const meds = [];
		for (let i = 0; i < resamples; i += 1) {
			const sample = [];
			for (let j = 0; j < n; j += 1) sample.push(ds[r.int(n)]);
			meds.push(median(sample));
		}
		const abs = meds.map(Math.abs);
		return { p2_5: round(quantile(meds, 0.025)), p97_5: round(quantile(meds, 0.975)), absP90: round(quantile(abs, 0.9)), absP95: round(quantile(abs, 0.95)), absP99: round(quantile(abs, 0.99)) };
	};
	if (n === 0) return { n, error: "no pairs" };
	const cb = boot(dCost);
	const wb = boot(dWall);
	const resolves = cb.absP95 <= margin;
	return {
		n,
		resamples,
		seed,
		margin,
		cost: { median: round(median(dCost)), sd: round(sd(dCost)), bootstrap: cb, max: round(Math.max(...dCost)), min: round(Math.min(...dCost)) },
		wall: { median: round(median(dWall)), sd: round(sd(dWall)), bootstrap: wb },
		resolves,
		...(resolves ? {} : { nFor: { projected: true, n: Math.ceil(n * (cb.absP95 / margin) ** 2) } }),
		pairs: pairs.map((p, i) => ({ id: p.id, dCost: round(dCost[i]), dWall: round(dWall[i]) })),
	};
}

function main(argv) {
	const [aPath, bPath, ...rest] = argv;
	if (!aPath || !bPath) {
		console.error("usage: null-calibration.mjs <a.json> <b.json> [--resamples=N] [--seed=S] [--margin=0.2]");
		process.exit(2);
	}
	const opt = (k, d) => rest.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
	const rows = (p) => {
		const x = JSON.parse(readFileSync(p, "utf8"));
		return Array.isArray(x) ? x : (x.runs ?? []);
	};
	const out = calibrate(rows(aPath), rows(bPath), { resamples: Number(opt("resamples", 10000)), seed: opt("seed", "null-calibration"), margin: Number(opt("margin", 0.2)) });
	console.log(JSON.stringify(out, null, 1));
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
