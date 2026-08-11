/** The built artifact has no .d.ts — declare its exports for the tests. */
declare module "*.mjs" {
	export interface TaskItem {
		text: string;
		status: "pending" | "active" | "done";
	}
	export function parseTaskSet(input: unknown): { items?: TaskItem[]; error?: string };
	export function taskEcho(items: readonly TaskItem[]): string;
	const factory: () => import("@vincemakes/kiso-core").KisoExtension;
	export default factory;
}
