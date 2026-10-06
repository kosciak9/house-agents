import { defineDoc } from "@earendil-works/pi-durable";
import { Cron } from "croner";

export type Schedule =
	| {
			type: "wakeup";
			fireAt: number;
			prompt: string;
			label: string | null;
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

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const parseCron = (cron: string): Cron =>
	new Cron(cron, { mode: "5-part", paused: true });

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

export const formatTime = (time: number): string =>
	new Date(time).toLocaleString("en-GB", { timeZone: TIME_ZONE });

export const describeSchedule = (schedule: Schedule): string =>
	schedule.type === "wakeup"
		? `wakeup at ${formatTime(schedule.fireAt)}`
		: `cron "${schedule.cron}" (${schedule.recurring ? "recurring" : "one-shot"}), next at ${formatTime(schedule.nextFireAt)}`;
