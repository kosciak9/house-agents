import { defineDoc } from "@earendil-works/pi-durable";
import { Cron } from "croner";

import { config } from "../config.ts";
import { toWall } from "./wall.ts";

export type Schedule =
	| {
			type: "wakeup";
			fireAt: number;
			prompt: string;
			label: string | null;
			/** Set by the harness (`keepWakes`), not the agent: whose and which. */
			origin?: string;
			key?: string;
	  }
	| {
			type: "cron";
			cron: string;
			recurring: boolean;
			nextFireAt: number;
			prompt: string;
			label: string | null;
	  };

// Index of a conversation's active schedules, keyed by the id of the task that
// fires them. Removing an entry cancels the schedule: its task notices and
// aborts itself.
export const Schedules = defineDoc<{ schedules: Record<string, Schedule> }>({
	kind: "scheduler.schedules",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ schedules: {} }),
});

/** The user's time zone: the agent reads and sets every time in it. */
export const TIME_ZONE =
	config().timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const parseCron = (cron: string): Cron =>
	new Cron(cron, { mode: "5-or-6-parts", paused: true, timezone: TIME_ZONE });

export const isValidCron = (cron: string): boolean => {
	try {
		parseCron(cron);
		return true;
	} catch {
		return false;
	}
};

export const nextCronRun = (cron: string, after: number): number | undefined =>
	parseCron(cron).nextRun(new Date(after))?.getTime();

/** `time` as the agent reads and writes it, `YYYY-MM-DD HH:MM` in `TIME_ZONE`. */
export const formatTime = (time: number): string => toWall(time, TIME_ZONE);

/** When `schedule` fires next. */
export const nextFire = (schedule: Schedule): number =>
	schedule.type === "wakeup" ? schedule.fireAt : schedule.nextFireAt;

export const describeSchedule = (schedule: Schedule): string =>
	schedule.type === "wakeup"
		? `wakeup at ${formatTime(schedule.fireAt)}`
		: `cron "${schedule.cron}" (${schedule.recurring ? "recurring" : "one-shot"}), next at ${formatTime(schedule.nextFireAt)}`;
