/** The built artifact has no .d.ts — declare its exports for the tests. */
declare module "*.mjs" {
	const factory: () => Promise<import("@vincemakes/kiso-core").KisoExtension>;
	export default factory;
	export function rolePolicyContent(role: string): string;
	export function extractChildResult(
		sessionsDir: string,
		childId: string,
		diag: string,
	): {
		outcome: string;
		toolCalls: number;
		text: string;
		failed: boolean;
		reason: string;
		diag: string;
	};
}
