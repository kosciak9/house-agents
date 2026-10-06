import { defineExtension } from "@earendil-works/pi-durable";

import { CronTask, WakeupTask } from "./tasks.ts";
import {
	cronCreateTool,
	cronDeleteTool,
	cronListTool,
	scheduleWakeupTool,
} from "./tools.ts";

export const SchedulerExtension = defineExtension({
	name: "scheduler",
	tasks: [WakeupTask, CronTask],
	tools: [scheduleWakeupTool, cronCreateTool, cronListTool, cronDeleteTool],
});
