import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineTask,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";

import { nextCronRun, type Schedule, Schedules } from "./schedules.ts";

export type WakeupInput = {
	fireAt: number;
	prompt: string;
};

type WakeupState = { phase: "waiting" };

export type CronInput = {
	cron: string;
	recurring: boolean;
	firstFireAt: number;
	prompt: string;
};

type CronState =
	| { phase: "waiting"; nextFireAt: number }
	| { phase: "firing"; scheduledFor: number };

const completed = {
	status: "terminal",
	outcome: { status: "completed", result: null },
} as const;

const aborted = {
	status: "terminal",
	outcome: { status: "aborted" },
} as const;

const removeSchedule = async (
	tx: Tx,
	conversationId: ConversationId,
	taskId: TaskId,
): Promise<void> => {
	delete (await tx.doc(Schedules, conversationId)).schedules[taskId];
};

// Sleeps until `deadline`, waking early once the schedule leaves the index.
const sleepUntilDueOrCancelled = async <I, S extends { phase: string }, R>(
	runtime: TaskRuntime<I, S, R, object>,
	deadline: number,
	context: Context,
): Promise<"due" | "cancelled"> => {
	const { context: sleepContext, cancel } = withCancel(context);
	const watch = await runtime.watchDoc(
		Schedules,
		runtime.conversationId,
		sleepContext,
	);

	const cancelled = new Promise<"cancelled">((resolve) => {
		const check = (value: { schedules: Record<string, Schedule> } | null) => {
			if (value?.schedules[runtime.taskId] === undefined) resolve("cancelled");
		};
		check(watch?.value ?? null);
		watch?.start(async (value) => check(value));
	});

	try {
		return await Promise.race([
			runtime.sleep(deadline, sleepContext).then(() => "due" as const),
			cancelled,
		]);
	} finally {
		cancel();
		await watch?.stop();
	}
};

const isScheduled = async <I, S extends { phase: string }, R>(
	runtime: TaskRuntime<I, S, R, object>,
	context: Context,
): Promise<boolean> =>
	(await runtime.snapshot(Schedules, runtime.conversationId, context))
		?.schedules[runtime.taskId] !== undefined;

const submitPrompt = async <I, S extends { phase: string }, R>(
	runtime: TaskRuntime<I, S, R, object>,
	prompt: string,
	requestId: string,
	context: Context,
): Promise<void> => {
	const conversation = await runtime.conversation(
		runtime.conversationId,
		context,
	);
	if (!conversation) {
		throw new Error(`Conversation ${runtime.conversationId} no longer exists`);
	}

	// The request id keeps a fire retried after a crash from submitting twice.
	await conversation.submit(
		{ type: "input", content: prompt, whenBusy: "followUp", requestId },
		context,
	);
};

export const WakeupTask = defineTask<WakeupInput, WakeupState, null>({
	name: "scheduler.wakeup",
	version: 1,

	initial: () => ({ phase: "waiting" }),

	phases: {
		waiting: async (task, runtime, context) => {
			const wake = await sleepUntilDueOrCancelled(
				runtime,
				task.input.fireAt,
				context,
			);
			if (wake === "cancelled") {
				await runtime.commit(() => aborted, context);
				return;
			}

			await submitPrompt(
				runtime,
				task.input.prompt,
				`wakeup:${task.id}`,
				context,
			);

			await runtime.commit(async (tx) => {
				await removeSchedule(tx, runtime.conversationId, task.id);
				return completed;
			}, context);
		},
	},

	abort: (task, runtime, context) =>
		runtime.commit(async (tx) => {
			await removeSchedule(tx, runtime.conversationId, task.id);
			return aborted;
		}, context),
});

export const CronTask = defineTask<CronInput, CronState, null>({
	name: "scheduler.cron",
	version: 1,

	initial: ({ firstFireAt }) => ({ phase: "waiting", nextFireAt: firstFireAt }),

	phases: {
		waiting: async (task, runtime, context) => {
			const { nextFireAt } = task.state.checkpoint;
			const wake = await sleepUntilDueOrCancelled(runtime, nextFireAt, context);

			await runtime.commit(
				() =>
					wake === "cancelled"
						? aborted
						: {
								status: "running",
								checkpoint: { phase: "firing", scheduledFor: nextFireAt },
							},
				context,
			);
		},

		firing: async (task, runtime, context) => {
			if (!(await isScheduled(runtime, context))) {
				await runtime.commit(() => aborted, context);
				return;
			}

			const { scheduledFor } = task.state.checkpoint;
			await submitPrompt(
				runtime,
				task.input.prompt,
				`cron:${task.id}:${scheduledFor}`,
				context,
			);

			// Runs missed while the process was down collapse into this one fire.
			const next = task.input.recurring
				? nextCronRun(task.input.cron, Math.max(runtime.now(), scheduledFor))
				: undefined;

			await runtime.commit(async (tx) => {
				if (next === undefined) {
					await removeSchedule(tx, runtime.conversationId, task.id);
					return completed;
				}

				const schedule = (await tx.doc(Schedules, runtime.conversationId))
					.schedules[task.id];
				if (schedule?.type === "cron") schedule.nextFireAt = next;

				return {
					status: "running",
					checkpoint: { phase: "waiting", nextFireAt: next },
				};
			}, context);
		},
	},

	abort: (task, runtime, context) =>
		runtime.commit(async (tx) => {
			await removeSchedule(tx, runtime.conversationId, task.id);
			return aborted;
		}, context),
});
