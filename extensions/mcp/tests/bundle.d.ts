/** The built bundle has no .d.ts (esbuild emits no declarations) — declare
 *  its default export so the tests typecheck against the real artifact.
 *  Astra F7: the factory takes the host's declared secret env-var names;
 *  omitted (a standalone load) it strips by the exact list and the two
 *  suffix families alone, exactly as before. Kept in step with the
 *  published surface in ../index.d.ts. */
declare module "*.mjs" {
	const factory: (opts?: { readonly secretEnvNames?: readonly string[] }) => Promise<import("@vincemakes/kiso-core").KisoExtension>;
	export default factory;
}
