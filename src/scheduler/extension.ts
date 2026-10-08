import { defineExtension, section } from "@earendil-works/pi-durable";

import { SCHEDULED_INSTRUCTIONS } from "./silent.ts";
import { CronTask, WakeupTask } from "./tasks.ts";
import {
	cronCreateTool,
	cronDeleteTool,
	cronListTool,
	scheduleWakeupTool,
} from "./tools.ts";

export const SchedulerExtension = defineExtension({
	name: "scheduler",
	sections: [section("scheduler", () => SCHEDULED_INSTRUCTIONS)],
	tasks: [WakeupTask, CronTask],
	tools: [scheduleWakeupTool, cronCreateTool, cronListTool, cronDeleteTool],
});
