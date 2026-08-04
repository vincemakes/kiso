/** The built artifact has no .d.ts — declare its exports for the tests. */
declare module "*.mjs" {
	const factory: () => Promise<import("@vincemakes/kiso-core").KisoExtension>;
	export default factory;
}
