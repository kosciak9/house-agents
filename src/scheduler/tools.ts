import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import {
	describeSchedule,
	formatTime,
	isValidCron,
	nextCronRun,
	Schedules,
	TIME_ZONE,
} from "./schedules.ts";
import { CronTask, WakeupTask } from "./tasks.ts";

const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 60 * 60;

const taskOptions = {
	ownership: { kind: "conversation" },
	background: true,
} as const;

const text = (lines: readonly (string | undefined)[]) => ({
	content: [
		{
			type: "text" as const,
			text: lines.filter((line) => line !== undefined).join("\n"),
		},
	],
});

export const scheduleWakeupTool = defineTool({
	name: "schedule_wakeup",

	description:
		"Wake yourself up once after a delay: the prompt is sent back to this conversation.",

	parameters: Type.Object({
		delaySeconds: Type.Number({
			description: "Number of seconds from now to wake up (1-3600).",
		}),
		prompt: Type.String({
			description: "Prompt to submit when the timer fires.",
		}),
		reason: Type.Optional(
			Type.String({
				description: "Short explanation of why the wake-up is needed.",
			}),
		),
	}),

	execute: async (args, api, context) => {
		const delaySeconds = Math.min(
			MAX_DELAY_SECONDS,
			Math.max(MIN_DELAY_SECONDS, args.delaySeconds),
		);
		const fireAt = Date.now() + delaySeconds * 1000;

		const taskId = await api.commit(async (tx) => {
			const id = await tx.createTask(
				WakeupTask,
				{ fireAt, prompt: args.prompt },
				taskOptions,
			);
			(await tx.doc(Schedules, api.conversationId)).schedules[id] = {
				type: "wakeup",
				fireAt,
				prompt: args.prompt,
				label: args.reason ?? null,
			};
			return id;
		}, context);

		return text([
			"Wake-up scheduled.",
			`ID: ${taskId}`,
			`Fires at: ${formatTime(fireAt)} (${TIME_ZONE})`,
			args.reason ? `Reason: ${args.reason}` : undefined,
		]);
	},
});

export const cronCreateTool = defineTool({
	name: "cron_create",

	description:
		"Schedule a prompt that wakes you up on a 5-field cron expression " +
		"(minute hour day-of-month month day-of-week), recurring or once at the next match. " +
		`Times are in ${TIME_ZONE}. Examples: "*/5 * * * *" every 5 minutes, ` +
		'"0 9 * * 1-5" weekdays at 9:00, "0 9 24 12 *" on 24 December at 9:00.',

	parameters: Type.Object({
		cron: Type.String({
			description: `5-field cron expression in ${TIME_ZONE} time.`,
		}),
		prompt: Type.String({
			description: "Prompt to submit when the schedule fires.",
		}),
		recurring: Type.Optional(
			Type.Boolean({
				description:
					"true (default): fire on every match; false: fire once at the next match.",
			}),
		),
		label: Type.Optional(
			Type.String({ description: "Short human-readable name." }),
		),
	}),

	execute: async (args, api, context) => {
		if (!isValidCron(args.cron)) {
			return text([
				`Invalid cron expression "${args.cron}". Use 5 fields: minute hour day-of-month month day-of-week.`,
			]);
		}

		const firstFireAt = nextCronRun(args.cron, Date.now());
		if (firstFireAt === undefined) {
			return text([`Cron expression "${args.cron}" never matches.`]);
		}

		const recurring = args.recurring ?? true;
		const taskId = await api.commit(async (tx) => {
			const id = await tx.createTask(
				CronTask,
				{ cron: args.cron, recurring, firstFireAt, prompt: args.prompt },
				taskOptions,
			);
			(await tx.doc(Schedules, api.conversationId)).schedules[id] = {
				type: "cron",
				cron: args.cron,
				recurring,
				nextFireAt: firstFireAt,
				prompt: args.prompt,
				label: args.label ?? null,
			};
			return id;
		}, context);

		return text([
			"Cron schedule created.",
			`ID: ${taskId}`,
			args.label ? `Label: ${args.label}` : undefined,
			`Schedule: "${args.cron}" (${recurring ? "recurring" : "one-shot"})`,
			`Next fire: ${formatTime(firstFireAt)} (${TIME_ZONE})`,
		]);
	},
});

export const cronListTool = defineTool({
	name: "cron_list",
	description:
		"List active schedules (cron schedules and wake-ups) with their IDs, next fire times, and prompts.",
	parameters: Type.Object({}),
	replay: "safe",

	execute: async (_args, api, context) => {
		const index = await api.snapshot(Schedules, api.conversationId, context);
		const schedules = Object.entries(index?.schedules ?? {});
		if (schedules.length === 0) return text(["No active schedules."]);

		return text(
			schedules.flatMap(([id, schedule]) => [
				`[${id}]${schedule.label ? ` ${schedule.label}:` : ""} ${describeSchedule(schedule)}`,
				`  Prompt: ${schedule.prompt}`,
			]),
		);
	},
});

export const cronDeleteTool = defineTool({
	name: "cron_delete",
	description:
		"Cancel a schedule (cron schedule or wake-up) by ID. Use cron_list to see IDs.",
	parameters: Type.Object({
		id: Type.String({ description: "ID of the schedule to cancel." }),
	}),
	replay: "safe",

	// Removing the index entry cancels the schedule; its task sees the removal
	// and aborts itself.
	execute: async (args, api, context) => {
		const removed = await api.commit(async (tx) => {
			const { schedules } = await tx.doc(Schedules, api.conversationId);
			if (schedules[args.id] === undefined) return false;
			delete schedules[args.id];
			return true;
		}, context);

		return text([
			removed
				? `Schedule ${args.id} cancelled.`
				: `No schedule with ID "${args.id}". Use cron_list to see active schedules.`,
		]);
	},
});
