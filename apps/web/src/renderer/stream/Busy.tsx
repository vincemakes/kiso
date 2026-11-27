import { useEffect, useRef, type ReactNode } from "react";

// The running mark (owner 2026-11-27): the kiso mark's four lobes as four grey dots, in one loop of about 14 s. Every segment starts
// and ends at rest (the dots on the lobes), so the joins do not show. ONE requestAnimationFrame ticker draws every mark on screen
// and stops when the last one unmounts; each mark keeps a phase from its seed, so parallel steps are not in step. Reduced motion: rest.
type Dot = readonly [x: number, y: number, r: number, v: number];
const LOBES: readonly (readonly [number, number])[] = [[28, 28], [72, 28], [72, 72], [28, 72]];
const R = 14;
const REST = 0.62;
const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const wave = (x: number): number => 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
const at = (i: number, k: number, turn = 0): readonly [number, number] => {
	const [x0, y0] = LOBES[i]!;
	const [s, c] = [Math.sin(turn), Math.cos(turn)];
	const [x, y] = [50 + (x0 - 50) * c - (y0 - 50) * s, 50 + (x0 - 50) * s + (y0 - 50) * c];
	return [x + (50 - x) * k, y + (50 - y) * k];
};
const breath = (c: number, i: number): Dot => ((k) => [...at(i, k * 0.6), R - 4 * k, REST] as const)(ease(wave(c)));
const SEGMENTS: readonly (readonly [ms: number, f: (c: number, i: number) => Dot])[] = [
	[2000, breath],
	[2200, (c, i) => ((k) => [...at(i, k * 0.6, (ease(c) * Math.PI) / 2), R - 4 * k, REST] as const)(ease(wave(c)))],
	[700, (_, i) => [...at(i, 0), R, REST]],
	[2400, (c, i) => ((d) => ((k) => [...at(i, k * 0.45), R, REST + (0.95 - REST) * k] as const)(d > 0 && d < 1 ? Math.sin(d * Math.PI) : 0))(c * 4 - i)],
	[2200, (c, i) => ((l) => [...at(i, (l > 0 && l < 1 ? ease(wave(l)) : 0) * 0.45), R, REST] as const)(Math.min(1, Math.max(0, (c - i * 0.12) / 0.64)))],
	[2000, (c, i) => ((k) => [...at(i, k * 0.55), R - 3 * k, REST + 0.33 * k] as const)(ease(wave(c)))],
	[2400, (c, i) => ((k) => [...at(i, k), R + 4 * k, REST + 0.25 * k] as const)(c < 0.35 ? ease(c / 0.35) : c < 0.55 ? 1 : 1 - ease((c - 0.55) / 0.45))],
	[700, (_, i) => [...at(i, 0), R, REST]],
];
const LOOP = SEGMENTS.reduce((n, [ms]) => n + ms, 0);
function draw(svg: SVGSVGElement, t: number): void {
	let u = ((t % LOOP) + LOOP) % LOOP;
	let seg = SEGMENTS[0]!;
	for (const s of SEGMENTS) {
		seg = s;
		if (u < s[0]) break;
		u -= s[0];
	}
	Array.from(svg.children).forEach((dot, i) => {
		const [x, y, r, v] = seg[1](Math.min(1, u / seg[0]), i);
		dot.setAttribute("cx", x.toFixed(2));
		dot.setAttribute("cy", y.toFixed(2));
		dot.setAttribute("r", r.toFixed(2));
		dot.setAttribute("fill-opacity", (0.15 + 0.85 * v).toFixed(3));
	});
}
const marks = new Map<SVGSVGElement, number>();
let frame = 0;
// read by the proofs: the ticker's frames, the time spent drawing them, whether a frame is pending, and the marks it draws
const stats = { frames: 0, ms: 0, pending: false, mounted: 0 };
(window as unknown as { __kisoBusy?: typeof stats }).__kisoBusy = stats;
function tick(now: number): void {
	const t0 = performance.now();
	for (const [svg, phase] of marks) draw(svg, now + phase);
	stats.frames++;
	stats.ms += performance.now() - t0;
	frame = marks.size > 0 ? requestAnimationFrame(tick) : 0;
	stats.pending = frame !== 0;
}

export function Busy({ seed, size = 14 }: { readonly seed: string; readonly size?: number }): ReactNode {
	const ref = useRef<SVGSVGElement>(null);
	useEffect(() => {
		const svg = ref.current!;
		const phase = [...seed].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % LOOP, 0);
		draw(svg, 0);
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		marks.set(svg, phase);
		stats.mounted = marks.size;
		if (frame === 0) frame = requestAnimationFrame(tick);
		stats.pending = true;
		return () => {
			marks.delete(svg);
			stats.mounted = marks.size;
			if (marks.size === 0 && frame !== 0) {
				cancelAnimationFrame(frame);
				frame = 0;
				stats.pending = false;
			}
		};
	}, [seed]);
	return (
		<svg ref={ref} className="busy" viewBox="0 0 100 100" style={{ width: size, height: size }} data-kind="busy" aria-hidden="true">
			{LOBES.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={R} />)}
		</svg>
	);
}
