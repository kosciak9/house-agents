import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";

import { Schedules } from "./schedules.ts";
import { taskOptions, WakeupTask } from "./tasks.ts";

export type Wake = { key: string; at: number; prompt: string };

/**
 * Keeps exactly `wakes` among the wake-ups of `origin` (a source, the guard)
 * in the conversation's schedules: one whose time or prompt changed, or that
 * is no longer wanted, is cancelled, and the missing ones are created. They
 * are ordinary wake-ups labelled `origin`, which the agent lists; one it
 * cancels comes back while `origin` still wants it. Times past are left out.
 */
export const keepWakes = async (
	conversation: Conversation,
	origin: string,
	wakes: readonly Wake[],
	context: Context,
): Promise<void> => {
	const now = Date.now();
	const wanted = new Map(
		wakes.filter((wake) => wake.at > now).map((wake) => [wake.key, wake]),
	);
	await conversation.commit(async (tx) => {
		const { schedules } = await tx.doc(Schedules, conversation.id);
		for (const [id, schedule] of Object.entries(schedules)) {
			if (schedule.type !== "wakeup" || schedule.origin !== origin) continue;
			const wake =
				schedule.key === undefined ? undefined : wanted.get(schedule.key);
			if (wake?.at === schedule.fireAt && wake.prompt === schedule.prompt) {
				wanted.delete(wake.key);
			} else {
				// Its task notices and aborts itself.
				delete schedules[id];
			}
		}
		for (const wake of wanted.values()) {
			const id = await tx.createTask(
				WakeupTask,
				{ fireAt: wake.at, prompt: wake.prompt },
				taskOptions,
			);
			schedules[id] = {
				type: "wakeup",
				fireAt: wake.at,
				prompt: wake.prompt,
				label: origin,
				origin,
				key: wake.key,
			};
		}
	}, context);
};
