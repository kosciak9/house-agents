import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import {
	describeSchedule,
	formatTime,
	isValidCron,
	nextCronRun,
	type Schedule,
	Schedules,
	TIME_ZONE,
} from "./schedules.ts";
import { CronTask, taskOptions, WakeupTask } from "./tasks.ts";
import { fromWall } from "./wall.ts";

// The agent's own wake-ups pending at once; the harness's (a source's, the
// guard's) do not count.
export const MAX_OWN_SCHEDULES = 16;

const text = (lines: readonly (string | undefined)[]) => ({
	content: [
		{
			type: "text" as const,
			text: lines.filter((line) => line !== undefined).join("\n"),
		},
	],
});

const isOwn = (schedule: Schedule): boolean =>
	schedule.type === "cron" || schedule.origin === undefined;

const UNITS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 60 * 60_000,
	d: 24 * 60 * 60_000,
};

const MAX_DELAY = 366 * 24 * 60 * 60_000;

// The moment `at` names: a wall time in `TIME_ZONE`, or a delay from now
// ("+20s", "+15m", "+2h", "+1d") of up to a year, in whole seconds; `NaN` for
// anything else.
const momentOf = (at: string): number => {
	const delay = /^\+\s*(\d+)\s*([smhd])$/.exec(at.trim());
	if (!delay) return fromWall(at, TIME_ZONE);
	const ms = Number(delay[1]) * (UNITS[delay[2] as string] ?? Number.NaN);
	if (!(ms <= MAX_DELAY)) return Number.NaN;
	return Math.ceil((Date.now() + ms) / 1000) * 1000;
};

export const wakeAtTool = defineTool({
	name: "wake_at",

	description:
		"Wake yourself up at a moment, with a note on why: the note comes back to " +
		"you then, and you decide what to do (write to the user, start a worker, " +
		`or nothing). The moment is a ${TIME_ZONE} wall time or a delay from now. ` +
		"A note for a moment that already has a wake-up joins it, so one moment " +
		"wakes you once. Your wake-ups are listed in your prompt; cron_delete " +
		"cancels one.",

	parameters: Type.Object({
		at: Type.String({
			description: `YYYY-MM-DD HH:MM (seconds optional) in ${TIME_ZONE}, in the future, or a delay from now: +20s, +15m, +2h, +1d.`,
		}),
		note: Type.String({
			description: "Why you wake up: it is what you get at that moment.",
		}),
		daily: Type.Optional(
			Type.Boolean({ description: "Every day at this time from then on." }),
		),
	}),

	execute: async (args, api, context) => {
		const fireAt = momentOf(args.at);
		if (Number.isNaN(fireAt)) {
			return text([
				`Not set: give the time as YYYY-MM-DD HH:MM in ${TIME_ZONE}, or a delay of up to a year such as +20m.`,
			]);
		}
		if (fireAt <= Date.now()) {
			return text([
				`Not set: ${args.at} has passed; it is ${formatTime(Date.now())} now.`,
			]);
		}

		const outcome = await api.commit(async (tx) => {
			const { schedules } = await tx.doc(Schedules, api.conversationId);
			const own = Object.entries(schedules).filter(([, schedule]) =>
				isOwn(schedule),
			);
			const same = args.daily
				? undefined
				: own.find(
						([, schedule]) =>
							schedule.type === "wakeup" && schedule.fireAt === fireAt,
					);
			if (same === undefined && own.length >= MAX_OWN_SCHEDULES) {
				return { status: "full" } as const;
			}
			// The joined wake-up replaces the one already set; its task notices
			// the removal and aborts itself.
			const prompt = same ? `${same[1].prompt}\n${args.note}` : args.note;
			if (same) delete schedules[same[0]];
			if (args.daily) {
				// The moment's time of day in the zone; zones are whole minutes off
				// UTC, so its second is UTC's.
				const [hour, minute] = formatTime(fireAt).slice(11).split(":");
				const second = new Date(fireAt).getUTCSeconds();
				const cron = `${second} ${Number(minute)} ${Number(hour)} * * *`;
				const id = await tx.createTask(
					CronTask,
					{ cron, recurring: true, firstFireAt: fireAt, prompt },
					taskOptions,
				);
				schedules[id] = {
					type: "cron",
					cron,
					recurring: true,
					nextFireAt: fireAt,
					prompt,
					label: null,
				};
				return { status: "set", id, joined: false } as const;
			}
			const id = await tx.createTask(
				WakeupTask,
				{ fireAt, prompt },
				taskOptions,
			);
			schedules[id] = { type: "wakeup", fireAt, prompt, label: null };
			return { status: "set", id, joined: same !== undefined } as const;
		}, context);

		if (outcome.status === "full") {
			return text([
				`Not set: you have ${MAX_OWN_SCHEDULES} wake-ups and schedules pending; cancel one you no longer need (cron_delete) first.`,
			]);
		}
		return text([
			outcome.joined
				? `Joined the wake-up already set for ${formatTime(fireAt)} (${TIME_ZONE}).`
				: `Wake-up set for ${formatTime(fireAt)} (${TIME_ZONE})${args.daily ? ", then every day at this time" : ""}.`,
			`ID: ${outcome.id}`,
		]);
	},
});

export const cronCreateTool = defineTool({
	name: "cron_create",

	description:
		"Schedule a prompt that wakes you up on a 5-field cron expression " +
		"(minute hour day-of-month month day-of-week), or 6 fields with a leading second, " +
		"recurring or once at the next match. " +
		`Times are in ${TIME_ZONE}. Examples: "*/5 * * * *" every 5 minutes, ` +
		'"0 9 * * 1-5" weekdays at 9:00, "0 9 24 12 *" on 24 December at 9:00. ' +
		"A last resort: wake_at covers a moment and every day; a recurring " +
		"schedule only when the user asks for one and nothing else brings the event.",

	parameters: Type.Object({
		cron: Type.String({
			description: `5-field cron expression (or 6 with a leading second) in ${TIME_ZONE} time.`,
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
				`Invalid cron expression "${args.cron}". Use 5 fields: minute hour day-of-month month day-of-week, or 6 with a leading second.`,
			]);
		}

		const firstFireAt = nextCronRun(args.cron, Date.now());
		if (firstFireAt === undefined) {
			return text([`Cron expression "${args.cron}" never matches.`]);
		}

		const recurring = args.recurring ?? true;
		const taskId = await api.commit(async (tx) => {
			const { schedules } = await tx.doc(Schedules, api.conversationId);
			if (Object.values(schedules).filter(isOwn).length >= MAX_OWN_SCHEDULES) {
				return undefined;
			}
			const id = await tx.createTask(
				CronTask,
				{ cron: args.cron, recurring, firstFireAt, prompt: args.prompt },
				taskOptions,
			);
			schedules[id] = {
				type: "cron",
				cron: args.cron,
				recurring,
				nextFireAt: firstFireAt,
				prompt: args.prompt,
				label: args.label ?? null,
			};
			return id;
		}, context);

		if (taskId === undefined) {
			return text([
				`Not created: you have ${MAX_OWN_SCHEDULES} wake-ups and schedules pending; cancel one you no longer need (cron_delete) first.`,
			]);
		}
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
