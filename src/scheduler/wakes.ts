import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Tx,
} from "@earendil-works/pi-durable";

import { Schedules } from "./schedules.ts";
import { taskOptions, WakeupTask } from "./tasks.ts";

export type Wake = { key: string; at: number; prompt: string };

/**
 * Keeps exactly `wakes` among the wake-ups of `origin` (a source, the guard)
 * in the schedules of `conversationId`, within `tx`: one whose time or prompt
 * changed, or that is no longer wanted, is cancelled, and the missing ones
 * are created. They are ordinary wake-ups labelled `origin`, which the agent
 * lists; one it cancels comes back while `origin` still wants it. Times past
 * are left out.
 */
export const keepWakesIn = async (
	tx: Tx,
	conversationId: ConversationId,
	origin: string,
	wakes: readonly Wake[],
): Promise<void> => {
	const now = Date.now();
	const wanted = new Map(
		wakes.filter((wake) => wake.at > now).map((wake) => [wake.key, wake]),
	);
	const { schedules } = await tx.doc(Schedules, conversationId);
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
		// Of `conversationId`, also when a worker's tool commits (source_set).
		const id = await tx.createTask(
			WakeupTask,
			{ fireAt: wake.at, prompt: wake.prompt },
			{ ...taskOptions, conversationId },
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
};

/** `keepWakesIn` a commit of its own. */
export const keepWakes = (
	conversation: Conversation,
	origin: string,
	wakes: readonly Wake[],
	context: Context,
): Promise<void> =>
	conversation.commit(
		(tx) => keepWakesIn(tx, conversation.id, origin, wakes),
		context,
	);
