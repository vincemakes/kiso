/** The built bundle has no .d.ts (esbuild emits no declarations) — declare
 *  its default export so the tests typecheck against the real artifact. */
declare module "*.mjs" {
	const factory: () => Promise<import("@vincemakes/kiso-core").KisoExtension>;
	export default factory;
}
