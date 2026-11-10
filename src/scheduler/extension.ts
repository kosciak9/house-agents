import { defineExtension, section } from "@earendil-works/pi-durable";

import { SCHEDULED_INSTRUCTIONS } from "./scheduled.ts";
import {
	formatTime,
	nextFire,
	type Schedule,
	Schedules,
	TIME_ZONE,
} from "./schedules.ts";
import { CronTask, WakeupTask } from "./tasks.ts";
import {
	cronCreateTool,
	cronDeleteTool,
	cronListTool,
	wakeAtTool,
} from "./tools.ts";

// Each one in the prompt on one line, its prompt's first line clipped; the
// listing (cron_list) has them whole.
const CLIP = 120;
const MAX_LISTED = 40;

const lineOf = ([id, schedule]: [string, Schedule]): string => {
	const when =
		schedule.type === "wakeup"
			? formatTime(schedule.fireAt)
			: `${formatTime(schedule.nextFireAt)} (cron "${schedule.cron}"${schedule.recurring ? "" : ", once"})`;
	const label = schedule.label ? ` [${schedule.label}]` : "";
	const first = schedule.prompt.trim().split("\n")[0] ?? "";
	const prompt =
		first.length > CLIP || schedule.prompt.trim().includes("\n")
			? `${first.slice(0, CLIP)}…`
			: first;
	return `- ${when}${label} ${id}: ${prompt}`;
};

// What wakes the agent and when, nearest first: its own wake-ups and those
// the harness keeps for it (labelled by whose they are).
const wakeups = section("wakeups", async (input, context) => {
	const index = await input.read.snapshot(
		Schedules,
		input.conversationId,
		context,
	);
	const all = Object.entries(index?.schedules ?? {}).sort(
		([, a], [, b]) => nextFire(a) - nextFire(b),
	);
	const lines = all.slice(0, MAX_LISTED).map(lineOf);
	if (all.length > MAX_LISTED) {
		lines.push(`- and ${all.length - MAX_LISTED} more (cron_list)`);
	}
	return `Your wake-ups, nearest first, in ${TIME_ZONE} (id after the time; cron_delete cancels one):\n${lines.join("\n") || "(none)"}`;
});

export const SchedulerExtension = defineExtension({
	name: "scheduler",
	sections: [section("scheduler", () => SCHEDULED_INSTRUCTIONS), wakeups],
	tasks: [WakeupTask, CronTask],
	tools: [wakeAtTool, cronCreateTool, cronListTool, cronDeleteTool],
});
