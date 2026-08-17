/** The built artifact has no .d.ts — declare its exports for the tests. */
declare module "*.mjs" {
	const factory: (ui?: {
		ask(spec: unknown, signal?: unknown): Promise<unknown>;
	}) => Promise<import("@vincemakes/kiso-core").KisoExtension>;
	export default factory;
	export const ASK_PARAMETERS: Readonly<Record<string, unknown>>;
}
