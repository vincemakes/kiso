/**
 * ADR-0058 (3c): the row a task delivery shows in the transcript — live and
 * on resume. The model reads the notice's own lines; a person reads this.
 */
import type { TaskDeliveryItem } from "@vincemakes/kiso-core";

export function taskNoticeRow(items: readonly TaskDeliveryItem[]): string {
	return `✦ task ${items.map((i) => `${i.taskId} ${i.transition}`).join(" · ")}`;
}
